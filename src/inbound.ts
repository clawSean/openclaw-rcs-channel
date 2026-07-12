// Rcs plugin module implements inbound behavior.
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeRcsIdentity } from "./address.js";
import { sendRcsTextChunks } from "./send.js";
import type { RcsInboundMessage, ResolvedRcsAccount } from "./types.js";

const CHANNEL_ID = "rcs";

type RcsLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type RcsChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "pairing" | "reply" | "routing" | "session"
>;

function describeInboundBody(msg: RcsInboundMessage): string {
  const parts: string[] = [];
  if (msg.body) {
    parts.push(msg.body);
  }
  for (const mediaUrl of msg.mediaUrls) {
    parts.push(`[media] ${mediaUrl}`);
  }
  return parts.join("\n");
}

async function authorizeRcsSender(params: {
  cfg: OpenClawConfig;
  account: ResolvedRcsAccount;
  channelRuntime: RcsChannelRuntime;
  from: string;
}) {
  return await resolveStableChannelMessageIngress({
    channelId: CHANNEL_ID,
    accountId: params.account.accountId,
    cfg: params.cfg,
    identity: {
      key: "phone",
      entryIdPrefix: "rcs-entry",
    },
    readStoreAllowFrom: async () =>
      await params.channelRuntime.pairing.readAllowFromStore({
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
      }),
    subject: { stableId: params.from },
    conversation: {
      kind: "direct",
      id: "direct",
    },
    event: { mayPair: true },
    dmPolicy: params.account.dmPolicy,
    allowFrom: params.account.allowFrom,
  });
}

async function issueRcsPairingChallenge(params: {
  account: ResolvedRcsAccount;
  channelRuntime: RcsChannelRuntime;
  from: string;
  log?: RcsLog;
}) {
  const issueChallenge = createChannelPairingChallengeIssuer({
    channel: CHANNEL_ID,
    upsertPairingRequest: async (input) =>
      await params.channelRuntime.pairing.upsertPairingRequest({
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
        ...input,
      }),
  });
  await issueChallenge({
    senderId: params.from,
    senderIdLine: `Your RCS phone number: ${params.from}`,
    sendPairingReply: async (text) => {
      await sendRcsTextChunks({
        account: params.account,
        to: params.from,
        text,
      });
    },
    onCreated: () => {
      params.log?.info?.(`RCS pairing request created for ${params.from}`);
    },
    onReplyError: (err) => {
      params.log?.warn?.(`RCS pairing reply failed for ${params.from}: ${String(err)}`);
    },
  });
}

export async function dispatchRcsInboundEvent(params: {
  cfg: OpenClawConfig;
  account: ResolvedRcsAccount;
  msg: RcsInboundMessage;
  channelRuntime: RcsChannelRuntime;
  log?: RcsLog;
}): Promise<void> {
  const from = normalizeRcsIdentity(params.msg.from);
  const auth = await authorizeRcsSender({
    cfg: params.cfg,
    account: params.account,
    channelRuntime: params.channelRuntime,
    from,
  });
  if (!auth.senderAccess.allowed) {
    if (auth.senderAccess.decision === "pairing") {
      await issueRcsPairingChallenge({
        account: params.account,
        channelRuntime: params.channelRuntime,
        from,
        log: params.log,
      });
      return;
    }
    params.log?.warn?.(`RCS sender ${from} is not authorized`);
    return;
  }

  const route = params.channelRuntime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: from,
    },
  });
  const sessionKey = route.sessionKey;
  const bodyForAgent = describeInboundBody(params.msg);

  await params.channelRuntime.inbound.run({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    raw: params.msg,
    adapter: {
      ingest: (msg) => ({
        id: msg.messageSid,
        timestamp: Date.now(),
        rawText: bodyForAgent,
        textForAgent: bodyForAgent,
        textForCommands: msg.body,
        raw: msg,
      }),
      resolveTurn: async (input) => {
        const ctxPayload = params.channelRuntime.inbound.buildContext({
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          timestamp: input.timestamp,
          from: `rcs:${from}`,
          sender: {
            id: from,
            name: from,
          },
          conversation: {
            kind: "direct",
            id: from,
            label: from,
          },
          route: {
            agentId: route.agentId,
            accountId: params.account.accountId,
            routeSessionKey: sessionKey,
            dispatchSessionKey: sessionKey,
          },
          reply: {
            to: `rcs:${from}`,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: {
            MessageSid: params.msg.messageSid,
            To: params.msg.to,
            ViaRcs: params.msg.viaRcs ? "true" : "false",
            ...(params.msg.buttonPayload ? { ButtonPayload: params.msg.buttonPayload } : {}),
          },
        });
        const storePath = params.channelRuntime.session.resolveStorePath(
          params.cfg.session?.store,
          {
            agentId: route.agentId,
          },
        );
        return {
          cfg: params.cfg,
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          agentId: route.agentId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: params.channelRuntime.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            durable: () => ({
              to: from,
            }),
            deliver: async (payload) => {
              const text = payload.text;
              if (!text) {
                return { visibleReplySent: false };
              }
              await sendRcsTextChunks({
                account: params.account,
                to: from,
                text,
              });
              return { visibleReplySent: true };
            },
          },
          dispatcherOptions: {
            onReplyStart: () => {
              params.log?.info?.(`RCS reply started for ${from}`);
            },
          },
        };
      },
    },
  });
}
