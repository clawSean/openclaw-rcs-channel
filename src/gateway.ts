// Rcs plugin module implements gateway behavior.
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import type { ResolvedRcsAccount } from "./types.js";
import {
  createRcsSharedTwilioWebhookHandler,
  createRcsStatusCallbackHandler,
  createRcsWebhookHandler,
  type RcsWebhookHandlerParams,
} from "./webhook.js";

const CHANNEL_ID = "rcs";

const activeRoutes = new Map<string, () => void>();
const activeRoutePaths = new Map<string, string>();

type RcsGatewayLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function statusCallbackPath(webhookPath: string): string {
  return `${normalizeWebhookPath(webhookPath).replace(/\/+$/, "")}/status`;
}

export function collectRcsStartupWarnings(account: ResolvedRcsAccount): string[] {
  const warnings: string[] = [];
  if (
    !account.accountSid ||
    !account.authToken ||
    (!account.messagingServiceSid && !account.senderId)
  ) {
    warnings.push(
      "- RCS: accountSid, authToken, and messagingServiceSid or senderId are required.",
    );
  }
  if (!account.publicWebhookUrl && !account.dangerouslyDisableSignatureValidation) {
    warnings.push(
      "- RCS: publicWebhookUrl is required for Twilio signature validation. Set dangerouslyDisableSignatureValidation=true only for local testing.",
    );
  }
  if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
    warnings.push("- RCS: dmPolicy=allowlist with empty allowFrom rejects every sender.");
  }
  if (account.dmPolicy === "open" && !account.allowFrom.includes("*")) {
    warnings.push('- RCS: dmPolicy=open should set allowFrom=["*"] or explicit sender numbers.');
  }
  if (account.transport === "rcs-preferred") {
    warnings.push(
      "- RCS: transport=rcs-preferred can deliver over SMS/MMS fallback; delivery is not guaranteed to be RCS.",
    );
  }
  if (account.sharedWebhookPath && !account.smsForwardWebhookPath) {
    warnings.push("- RCS: smsForwardWebhookPath is required when sharedWebhookPath is set.");
  }
  if (
    account.sharedWebhookPath &&
    normalizeWebhookPath(account.sharedWebhookPath) === normalizeWebhookPath(account.webhookPath)
  ) {
    warnings.push(
      "- RCS: a sharedWebhookPath distinct from webhookPath is required; the shared Twilio route cannot replace the dedicated RCS route.",
    );
  }
  if (
    account.sharedWebhookPath &&
    account.smsForwardWebhookPath &&
    normalizeWebhookPath(account.smsForwardWebhookPath) ===
      normalizeWebhookPath(account.sharedWebhookPath)
  ) {
    warnings.push(
      "- RCS: an smsForwardWebhookPath distinct from sharedWebhookPath is required; forwarding the shared webhook to itself would loop.",
    );
  }
  if (
    account.sharedWebhookPath &&
    !account.sharedWebhookPublicUrl &&
    !account.dangerouslyDisableSignatureValidation
  ) {
    warnings.push(
      "- RCS: sharedWebhookPublicUrl is required for shared Twilio webhook signature validation.",
    );
  }
  return warnings;
}

function registerRoute(params: {
  path: string;
  accountId: string;
  handler: Parameters<typeof registerPluginHttpRoute>[0]["handler"];
  log?: RcsGatewayLog;
}): () => void {
  const key = `${params.accountId}:${params.path}`;
  const currentPathOwner = activeRoutePaths.get(params.path);
  if (currentPathOwner && currentPathOwner !== params.accountId) {
    throw new Error(
      `RCS webhook path ${params.path} is already registered by account ${currentPathOwner}; configure a distinct webhookPath for account ${params.accountId}.`,
    );
  }
  activeRoutes.get(key)?.();
  activeRoutePaths.delete(params.path);
  const unregister = registerPluginHttpRoute({
    path: params.path,
    auth: "plugin",
    pluginId: CHANNEL_ID,
    accountId: params.accountId,
    log: (msg) => params.log?.info?.(msg),
    handler: params.handler,
  });
  activeRoutes.set(key, unregister);
  activeRoutePaths.set(params.path, params.accountId);
  return () => {
    unregister();
    activeRoutes.delete(key);
    if (activeRoutePaths.get(params.path) === params.accountId) {
      activeRoutePaths.delete(params.path);
    }
  };
}

export function registerRcsWebhookRoutes(params: {
  cfg: RcsWebhookHandlerParams["cfg"];
  account: ResolvedRcsAccount;
  channelRuntime: RcsWebhookHandlerParams["channelRuntime"];
  log?: RcsGatewayLog;
}): () => void {
  const webhookPath = normalizeWebhookPath(params.account.webhookPath);
  const unregisterInbound = registerRoute({
    path: webhookPath,
    accountId: params.account.accountId,
    handler: createRcsWebhookHandler(params),
    log: params.log,
  });
  let unregisterStatus: (() => void) | undefined;
  let unregisterShared: (() => void) | undefined;
  if (params.account.statusCallbacks) {
    unregisterStatus = registerRoute({
      path: statusCallbackPath(webhookPath),
      accountId: params.account.accountId,
      handler: createRcsStatusCallbackHandler(params),
      log: params.log,
    });
  }
  if (params.account.sharedWebhookPath && params.account.smsForwardWebhookPath) {
    unregisterShared = registerRoute({
      path: normalizeWebhookPath(params.account.sharedWebhookPath),
      accountId: params.account.accountId,
      handler: createRcsSharedTwilioWebhookHandler({
        ...params,
        sharedPublicWebhookUrl:
          params.account.sharedWebhookPublicUrl || params.account.publicWebhookUrl,
        smsForwardWebhookPath: params.account.smsForwardWebhookPath,
      }),
      log: params.log,
    });
  }
  return () => {
    unregisterInbound();
    unregisterStatus?.();
    unregisterShared?.();
  };
}

export async function startRcsGatewayAccount(params: {
  cfg: RcsWebhookHandlerParams["cfg"];
  account: ResolvedRcsAccount;
  channelRuntime: RcsWebhookHandlerParams["channelRuntime"];
  abortSignal: AbortSignal;
  log?: RcsGatewayLog;
}) {
  if (!params.account.enabled) {
    params.log?.info?.(`RCS account ${params.account.accountId} is disabled`);
    return waitUntilAbort(params.abortSignal);
  }
  const warnings = collectRcsStartupWarnings(params.account);
  if (warnings.some((warning) => warning.includes("required"))) {
    for (const warning of warnings) {
      params.log?.warn?.(warning);
    }
    return waitUntilAbort(params.abortSignal);
  }
  for (const warning of warnings) {
    params.log?.warn?.(warning);
  }
  const unregister = registerRcsWebhookRoutes(params);
  params.log?.info?.(
    `Registered RCS webhook route ${params.account.webhookPath} for account ${params.account.accountId}`,
  );
  return waitUntilAbort(params.abortSignal, unregister);
}
