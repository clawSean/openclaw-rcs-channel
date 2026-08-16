// Rcs plugin module implements channel behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  inspectRcsAccount,
  isRcsAccountConfigured,
  listRcsAccountIds,
  resolveDefaultRcsAccountId,
  resolveRcsAccount,
} from "./accounts.js";
import { looksLikeRcsTarget, normalizeRcsAllowFrom, normalizeRcsIdentity } from "./address.js";
import { RcsChannelConfigSchema } from "./config-schema.js";
import { collectRcsStartupWarnings, startRcsGatewayAccount } from "./gateway.js";
import type { RcsChannelRuntime } from "./inbound.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import {
  createRcsChannelSendResult,
  sendRcsMedia,
  sendRcsTextChunks,
  toRcsPlainText,
} from "./send.js";
import {
  buildRcsDeliveryStatusLines,
  formatRcsProbeLines,
  probeRcsAccount,
  type RcsProbe,
} from "./status.js";
import type { ResolvedRcsAccount } from "./types.js";

const CHANNEL_ID = "rcs";

const rcsConfigAdapter = createHybridChannelConfigAdapter<ResolvedRcsAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: listRcsAccountIds,
  resolveAccount: resolveRcsAccount,
  defaultAccountId: resolveDefaultRcsAccountId,
  clearBaseFields: [
    "accountSid",
    "authToken",
    "messagingServiceSid",
    "webhookPath",
    "publicWebhookUrl",
    "dangerouslyDisableSignatureValidation",
    "dmPolicy",
    "allowFrom",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) =>
    normalizeStringEntries(allowFrom.map((entry) => normalizeRcsAllowFrom(String(entry)))),
});

const resolveRcsDmPolicy = createScopedDmSecurityResolver<ResolvedRcsAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: "openclaw pairing approve rcs <code>",
  normalizeEntry: normalizeRcsAllowFrom,
});

const collectRcsSecurityWarnings = createConditionalWarningCollector<ResolvedRcsAccount>(
  (account) =>
    account.dangerouslyDisableSignatureValidation &&
    "- RCS: Twilio signature validation is disabled. Only use this for local testing.",
  (account) =>
    account.dmPolicy === "open" &&
    account.allowFrom.includes("*") &&
    '- RCS: dmPolicy="open" allows any phone number to message the bot.',
);

function rcsSetupPatch(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of [
    "accountSid",
    "authToken",
    "messagingServiceSid",
    "webhookPath",
    "publicWebhookUrl",
    "dmPolicy",
    "allowFrom",
  ]) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch;
}

function applyRcsAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Record<string, unknown>;
}): OpenClawConfig {
  const patch = rcsSetupPatch(params.input);
  const channels = { ...params.cfg.channels };
  const current = { ...(channels[CHANNEL_ID] as Record<string, unknown> | undefined) };
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    channels[CHANNEL_ID] = { ...current, ...patch };
    return { ...params.cfg, channels };
  }
  const accounts = { ...(current.accounts as Record<string, unknown> | undefined) };
  accounts[params.accountId] = {
    ...(accounts[params.accountId] as Record<string, unknown> | undefined),
    ...patch,
  };
  channels[CHANNEL_ID] = { ...current, accounts };
  return { ...params.cfg, channels };
}

const rcsSetupContract = defineChannelSetupContract({
  fields: {
    accountSid: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--account-sid <sid>", description: "Twilio account SID" },
    },
    authToken: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--auth-token <token>", description: "Twilio auth token" },
    },
    messagingServiceSid: {
      kind: "string",
      cli: {
        flags: "--messaging-service-sid <sid>",
        description: "Twilio RCS Messaging Service SID",
      },
    },
    webhookPath: {
      kind: "string",
      cli: { flags: "--webhook-path <path>", description: "RCS webhook path" },
    },
    publicWebhookUrl: {
      kind: "string",
      cli: { flags: "--public-webhook-url <url>", description: "Public RCS webhook URL" },
    },
    dmPolicy: {
      kind: "choice",
      choices: ["pairing", "allowlist", "open", "disabled"],
      cli: { flags: "--dm-policy <policy>", description: "RCS DM policy" },
    },
    allowFrom: {
      kind: "string-list",
      cli: { flags: "--allow-from <numbers>", description: "Allowed RCS senders" },
    },
  },
  adapter: { applyAccountConfig: applyRcsAccountConfig },
});

function resolveRcsTo(ctx: { cfg: OpenClawConfig; accountId?: string | null; to: string }): {
  account: ResolvedRcsAccount;
  to: string;
} {
  const account = resolveRcsAccount(ctx.cfg, ctx.accountId);
  const to = normalizeRcsIdentity(ctx.to);
  if (!looksLikeRcsTarget(to)) {
    throw new Error(`Invalid RCS target: ${ctx.to}`);
  }
  return { account, to };
}

async function sendRcsText(ctx: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  onPlatformSendDispatch?: Parameters<typeof sendRcsTextChunks>[0]["onPlatformSendDispatch"];
  onDeliveryResult?: Parameters<typeof sendRcsTextChunks>[0]["onDeliveryResult"];
}) {
  const { account, to } = resolveRcsTo(ctx);
  const results = await sendRcsTextChunks({
    account,
    to,
    text: ctx.text,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    onDeliveryResult: ctx.onDeliveryResult,
  });
  return createRcsChannelSendResult({ results, kind: "text" });
}

async function sendRcsMediaMessage(ctx: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  onPlatformSendDispatch?: Parameters<typeof sendRcsMedia>[0]["onPlatformSendDispatch"];
  onDeliveryResult?: Parameters<typeof sendRcsMedia>[0]["onDeliveryResult"];
}) {
  const { account, to } = resolveRcsTo(ctx);
  const mediaUrls = resolveOutboundMediaUrls(ctx) ?? [];
  if (!mediaUrls.length) {
    if (!ctx.text) {
      throw new Error("RCS media send requires mediaUrl or text.");
    }
    const results = await sendRcsTextChunks({
      account,
      to,
      text: ctx.text,
      onPlatformSendDispatch: ctx.onPlatformSendDispatch,
      onDeliveryResult: ctx.onDeliveryResult,
    });
    return createRcsChannelSendResult({ results, kind: "text" });
  }
  const results = await sendRcsMedia({
    account,
    to,
    mediaUrls,
    ...(ctx.text ? { text: ctx.text } : {}),
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    onDeliveryResult: ctx.onDeliveryResult,
  });
  return createRcsChannelSendResult({ results, kind: "media" });
}

const rcsMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => await sendRcsText(ctx),
    media: async (ctx) => await sendRcsMediaMessage(ctx),
  },
});

export const rcsPlugin: ChannelPlugin<ResolvedRcsAccount, RcsProbe> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "RCS",
      selectionLabel: "RCS (Twilio)",
      detailLabel: "Twilio RCS",
      docsPath: "/channels/rcs",
      docsLabel: "rcs",
      blurb: "Twilio RCS Business Messaging with text, media, and delivery/read receipts.",
      order: 89,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: true,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: RcsChannelConfigSchema,
    setupContract: rcsSetupContract,
    config: {
      ...rcsConfigAdapter,
      inspectAccount: inspectRcsAccount,
      isConfigured: isRcsAccountConfigured,
      unconfiguredReason: () => "RCS requires accountSid, authToken, and messagingServiceSid.",
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.messagingServiceSid || "RCS",
        configured: isRcsAccountConfigured(account),
        enabled: account.enabled,
      }),
    },
    messaging: {
      targetPrefixes: ["rcs"],
      normalizeTarget: (target) => normalizeRcsIdentity(target),
      targetResolver: {
        looksLikeId: looksLikeRcsTarget,
        hint: "<+15551234567 or rcs:+15551234567>",
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    gateway: {
      startAccount: async (ctx) => {
        if (!ctx.channelRuntime) {
          ctx.log?.warn?.("RCS channel runtime is not available; webhook route not started");
          return;
        }
        const statusSink = createAccountStatusSink({
          accountId: ctx.account.accountId,
          setStatus: ctx.setStatus,
        });
        return await startRcsGatewayAccount({
          cfg: ctx.cfg,
          account: ctx.account,
          channelRuntime: ctx.channelRuntime as unknown as RcsChannelRuntime,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
          statusSink,
        });
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedRcsAccount, RcsProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      resolveAccountSnapshot: ({ account }) => {
        const configured = isRcsAccountConfigured(account);
        return {
          accountId: account.accountId,
          name: account.messagingServiceSid || "RCS",
          enabled: account.enabled,
          configured,
          extra: {
            statusState: !account.enabled ? "disabled" : configured ? "configured" : "unconfigured",
          },
        };
      },
      probeAccount: async ({ account, timeoutMs }) => await probeRcsAccount({ account, timeoutMs }),
      formatCapabilitiesProbe: ({ probe }) => formatRcsProbeLines(probe),
      buildCapabilitiesDiagnostics: async ({ account }) => ({
        lines: [
          ...collectRcsStartupWarnings(account).map((text) => ({ text, tone: "warn" as const })),
          // Surface the recorded read/delivered receipts on the channel status
          // surface so the agent can see whether its last outbound RCS message
          // was delivered or read, without depending on a live Twilio probe.
          ...(await buildRcsDeliveryStatusLines(account)),
        ],
      }),
    }),
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### RCS Formatting",
        "RCS sends plain text and media to RCS-enabled recipients only. Keep replies conversational; avoid markdown tables. Outbound media must use public http(s) URLs.",
      ],
    },
    message: rcsMessageAdapter,
  },
  pairing: {
    text: {
      idLabel: "phoneNumber",
      message: "OpenClaw: your RCS access has been approved.",
      normalizeAllowEntry: normalizeRcsAllowFrom,
      notify: async ({ cfg, id, message, accountId }) => {
        const account = resolveRcsAccount(cfg, accountId);
        await sendRcsTextChunks({
          account,
          to: normalizeRcsIdentity(id),
          text: message,
        });
      },
    },
  },
  security: {
    resolveDmPolicy: resolveRcsDmPolicy,
    collectWarnings: ({ account }) => collectRcsSecurityWarnings(account),
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 1600,
    resolveTarget: ({ to }) => {
      const explicit = normalizeRcsIdentity(to ?? "");
      if (explicit) {
        return { ok: true, to: explicit };
      }
      return { ok: false, error: new Error("RCS target must be an E.164 phone number.") };
    },
    sanitizeText: ({ text }) => toRcsPlainText(text),
    sendText: sendRcsText,
    sendMedia: async (ctx) => await sendRcsMediaMessage(ctx),
  },
});
