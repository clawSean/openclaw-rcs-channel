// Rcs plugin module implements gateway behavior.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import {
  channelBlockedPatch,
  channelReadyPatch,
  channelStoppedPatch,
} from "openclaw/plugin-sdk/gateway-runtime";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { createRcsIngressSpool, type RcsIngressLog } from "./ingress-spool.js";
import { parseRcsPublicWebhookUrl } from "./public-webhook-url.js";
import type { ResolvedRcsAccount } from "./types.js";
import { createRcsWebhookHandler, type RcsWebhookHandlerParams } from "./webhook.js";

const CHANNEL_ID = "rcs";

const activeRoutes = new Map<string, () => void>();
const activeRoutePaths = new Map<string, string>();
const activeAccounts = new Map<string, RcsActiveAccount>();
const pendingAccountStops = new Map<string, Promise<void>>();

type RcsActiveAccount = {
  ingress: ReturnType<typeof createRcsIngressSpool>;
  unregisterRoutes: () => void;
  ready: Promise<void>;
  stopTask?: Promise<void>;
};

type RcsGatewayLog = RcsIngressLog;

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function collectRcsStartupWarnings(account: ResolvedRcsAccount): string[] {
  const warnings: string[] = [];
  if (!account.accountSid || !account.authToken || !account.messagingServiceSid) {
    warnings.push("- RCS: accountSid, authToken, and messagingServiceSid are required.");
  }
  if (
    !account.dangerouslyDisableSignatureValidation &&
    !parseRcsPublicWebhookUrl(account.publicWebhookUrl)
  ) {
    warnings.push(
      "- RCS: a valid publicWebhookUrl is required for Twilio signature validation and status callbacks.",
    );
  }
  if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
    warnings.push("- RCS: dmPolicy=allowlist with empty allowFrom rejects every sender.");
  }
  if (account.dmPolicy === "open" && !account.allowFrom.includes("*")) {
    warnings.push('- RCS: dmPolicy=open should set allowFrom=["*"] or explicit sender numbers.');
  }
  return warnings;
}

function canStartRcsAccount(account: ResolvedRcsAccount): boolean {
  return Boolean(
    account.accountSid &&
    account.authToken &&
    account.messagingServiceSid &&
    (account.dangerouslyDisableSignatureValidation ||
      parseRcsPublicWebhookUrl(account.publicWebhookUrl)),
  );
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
  const handle = registerPluginHttpRoute({
    path: params.path,
    auth: "plugin",
    throwOnFailure: true,
    pluginId: CHANNEL_ID,
    accountId: params.accountId,
    log: (msg) => params.log?.info?.(msg),
    handler: params.handler,
  });
  activeRoutes.set(key, handle);
  activeRoutePaths.set(params.path, params.accountId);
  return () => {
    handle();
    activeRoutes.delete(key);
    if (activeRoutePaths.get(params.path) === params.accountId) {
      activeRoutePaths.delete(params.path);
    }
  };
}

function registerRcsWebhookRoutes(params: {
  cfg: RcsWebhookHandlerParams["cfg"];
  account: ResolvedRcsAccount;
  ingress: RcsWebhookHandlerParams["ingress"];
  log?: RcsGatewayLog;
}): () => void {
  const webhookPath = normalizeWebhookPath(params.account.webhookPath);
  return registerRoute({
    path: webhookPath,
    accountId: params.account.accountId,
    handler: createRcsWebhookHandler(params),
    log: params.log,
  });
}

function stopRcsWebhookAccount(accountId: string, active: RcsActiveAccount): Promise<void> {
  if (active.stopTask) {
    return active.stopTask;
  }
  const pauseTask = active.ingress.pause();
  active.unregisterRoutes();
  if (activeAccounts.get(accountId) === active) {
    activeAccounts.delete(accountId);
  }
  const previousStop = pendingAccountStops.get(accountId) ?? Promise.resolve();
  const stopTask = Promise.all([previousStop, active.ready, pauseTask]).then(
    () => active.ingress.stop(),
    async (error: unknown) => {
      await Promise.allSettled([active.ingress.stop()]);
      throw error;
    },
  );
  active.stopTask = stopTask;
  pendingAccountStops.set(accountId, stopTask);
  const clear = () => {
    if (pendingAccountStops.get(accountId) === stopTask) {
      pendingAccountStops.delete(accountId);
    }
  };
  void stopTask.then(clear, clear);
  return stopTask;
}

export async function startRcsGatewayAccount(params: {
  cfg: RcsWebhookHandlerParams["cfg"];
  account: ResolvedRcsAccount;
  channelRuntime: Parameters<typeof createRcsIngressSpool>[0]["channelRuntime"];
  abortSignal: AbortSignal;
  log?: RcsGatewayLog;
  statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
}) {
  params.statusSink?.({ lifecycle: "starting" });
  if (!params.account.enabled) {
    params.log?.info?.(`RCS account ${params.account.accountId} is disabled`);
    params.statusSink?.(channelStoppedPatch());
    return waitUntilAbort(params.abortSignal);
  }
  const warnings = collectRcsStartupWarnings(params.account);
  if (!canStartRcsAccount(params.account)) {
    for (const warning of warnings) {
      params.log?.warn?.(warning);
    }
    params.statusSink?.(
      channelBlockedPatch(warnings.join("; "), {
        running: true,
        connected: false,
      }),
    );
    return waitUntilAbort(params.abortSignal);
  }
  for (const warning of warnings) {
    params.log?.warn?.(warning);
  }
  const currentAccount = activeAccounts.get(params.account.accountId);
  const predecessorStop = currentAccount
    ? stopRcsWebhookAccount(params.account.accountId, currentAccount)
    : (pendingAccountStops.get(params.account.accountId) ?? Promise.resolve());
  const ingress = createRcsIngressSpool({
    cfg: params.cfg,
    account: params.account,
    channelRuntime: params.channelRuntime,
    ...(params.log ? { log: params.log } : {}),
  });
  let unregisterRoutes: () => void;
  try {
    unregisterRoutes = registerRcsWebhookRoutes({
      cfg: params.cfg,
      account: params.account,
      ingress,
      ...(params.log ? { log: params.log } : {}),
    });
  } catch (error) {
    await Promise.allSettled([predecessorStop, ingress.stop()]);
    params.statusSink?.(
      channelBlockedPatch(
        `RCS webhook route registration failed: ${error instanceof Error ? error.message : String(error)}`,
        { running: false, connected: false },
      ),
    );
    throw error;
  }
  const active: RcsActiveAccount = {
    ingress,
    unregisterRoutes,
    ready: Promise.resolve(),
  };
  activeAccounts.set(params.account.accountId, active);
  active.ready = predecessorStop.then(() => {
    if (activeAccounts.get(params.account.accountId) === active && !active.stopTask) {
      ingress.start();
    }
  });
  const stop = () => stopRcsWebhookAccount(params.account.accountId, active);
  const readinessAbort = new AbortController();
  const lifecycle = waitUntilAbort(
    AbortSignal.any([params.abortSignal, readinessAbort.signal]),
    stop,
  );
  try {
    await active.ready;
  } catch (error) {
    readinessAbort.abort();
    await Promise.allSettled([lifecycle]);
    params.statusSink?.(
      channelStoppedPatch({
        lastError: `RCS gateway startup failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    throw error;
  }
  params.log?.info?.(
    `Registered RCS webhook route ${params.account.webhookPath} for account ${params.account.accountId}`,
  );
  params.statusSink?.(channelReadyPatch());
  return lifecycle.finally(() => {
    params.statusSink?.(channelStoppedPatch());
  });
}
