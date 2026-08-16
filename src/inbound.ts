import {
  resolveStableChannelMessageIngress,
  type ChannelIngressContextBinding,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
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
  "commands" | "inbound" | "media" | "pairing" | "reply" | "routing" | "session"
>;

async function authorizeRcsSender(params: {
  cfg: OpenClawConfig;
  account: ResolvedRcsAccount;
  channelRuntime: RcsChannelRuntime;
  from: string;
  rawBody: string;
  contextBinding?: ChannelIngressContextBinding;
}) {
  const commandRequested = params.channelRuntime.commands.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  return await resolveStableChannelMessageIngress({
    channelId: CHANNEL_ID,
    accountId: params.account.accountId,
    cfg: params.cfg,
    identity: { key: "phone", entryIdPrefix: "rcs-entry" },
    readStoreAllowFrom: async () =>
      await params.channelRuntime.pairing.readAllowFromStore({
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
      }),
    subject: { stableId: params.from },
    conversation: { kind: "direct", id: params.from },
    contextBinding: params.contextBinding,
    event: { mayPair: true },
    dmPolicy: params.account.dmPolicy,
    allowFrom: params.account.allowFrom,
    command: commandRequested
      ? { cfg: params.cfg, modeWhenAccessGroupsOff: "configured" }
      : undefined,
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
    accountId: params.account.accountId,
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
      await sendRcsTextChunks({ account: params.account, to: params.from, text });
    },
    onCreated: () => params.log?.info?.("RCS pairing request created"),
    onReplyError: () => params.log?.warn?.("RCS pairing reply failed"),
  });
}

export async function dispatchRcsInboundEvent(params: {
  cfg: OpenClawConfig;
  account: ResolvedRcsAccount;
  msg: RcsInboundMessage;
  channelRuntime: RcsChannelRuntime;
  receivedAt: number;
  turnAdoptionLifecycle?: NonNullable<
    Parameters<RcsChannelRuntime["inbound"]["run"]>[0]["turnAdoptionLifecycle"]
  >;
  log?: RcsLog;
}): Promise<void> {
  const from = normalizeRcsIdentity(params.msg.from);
  let auth = await authorizeRcsSender({
    cfg: params.cfg,
    account: params.account,
    channelRuntime: params.channelRuntime,
    from,
    rawBody: params.msg.body,
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
    params.log?.warn?.("RCS sender is not authorized");
    return;
  }

  const materialized =
    params.msg.media.length > 0 || (params.msg.unavailableMediaCount ?? 0) > 0
      ? await (
          await import("./media.js")
        ).materializeRcsInboundMedia({
          account: params.account,
          msg: params.msg,
          mediaRuntime: params.channelRuntime,
          abortSignal: params.turnAdoptionLifecycle?.abortSignal,
          log: params.log,
        })
      : { body: params.msg.body, media: [], cleanup: async () => undefined };
  let adoptionState: "pending" | "deferred" | "adopted" | "abandoned" = "pending";
  try {
    const turnAdoptionLifecycle =
      materialized.media.length > 0 && params.turnAdoptionLifecycle
        ? {
            ...params.turnAdoptionLifecycle,
            onAdopted: async () => {
              try {
                await params.turnAdoptionLifecycle?.onAdopted();
                adoptionState = "adopted";
              } catch (error) {
                await materialized.cleanup();
                throw error;
              }
            },
            onDeferred: () => {
              const deferred = params.turnAdoptionLifecycle?.onDeferred?.();
              if (deferred !== false) {
                adoptionState = "deferred";
              }
              return deferred;
            },
            onAbandoned: () => {
              adoptionState = "abandoned";
              void materialized
                .cleanup()
                .then(() => params.turnAdoptionLifecycle?.onAbandoned?.())
                .catch(() => params.log?.warn?.("Failed to abandon Twilio RCS ingress media"));
            },
          }
        : params.turnAdoptionLifecycle;

    const route = params.channelRuntime.routing.resolveAgentRoute({
      cfg: params.cfg,
      channel: CHANNEL_ID,
      accountId: params.account.accountId,
      peer: { kind: "direct", id: from },
    });
    const sessionKey = route.sessionKey;
    auth = await authorizeRcsSender({
      cfg: params.cfg,
      account: params.account,
      channelRuntime: params.channelRuntime,
      from,
      rawBody: params.msg.body,
      contextBinding: {
        agentId: route.agentId,
        sessionKey,
        messageId: params.msg.messageSid,
        inboundEventKind: "user_request",
      },
    });
    if (!auth.senderAccess.allowed) {
      params.log?.warn?.("RCS sender authorization changed before dispatch");
      return;
    }
    const commandRequested = auth.commandAccess.requested;
    const commandAuthorized = auth.commandAccess.authorized;
    const isTextCommand = params.channelRuntime.commands.isControlCommandMessage(
      params.msg.body,
      params.cfg,
    );

    await params.channelRuntime.inbound.run({
      channel: CHANNEL_ID,
      accountId: params.account.accountId,
      raw: params.msg,
      ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
      adapter: {
        ingest: (msg) => ({
          id: msg.messageSid,
          timestamp: params.receivedAt,
          rawText: msg.body,
          textForAgent: materialized.body,
          textForCommands: msg.body,
          raw: msg,
        }),
        resolveTurn: async (input) => {
          const ctxPayload = params.channelRuntime.inbound.buildContext({
            channelIngress: auth,
            channel: CHANNEL_ID,
            accountId: params.account.accountId,
            messageId: input.id,
            timestamp: input.timestamp,
            from: `rcs:${from}`,
            sender: { id: from, name: from },
            conversation: { kind: "direct", id: from, label: from },
            route: {
              agentId: route.agentId,
              accountId: params.account.accountId,
              routeSessionKey: sessionKey,
              dispatchSessionKey: sessionKey,
            },
            reply: { to: `rcs:${from}` },
            message: {
              rawBody: input.rawText,
              commandBody: input.textForCommands,
              bodyForAgent: input.textForAgent,
            },
            media: materialized.media,
            access: commandRequested ? { commands: { authorized: commandAuthorized } } : undefined,
            command: isTextCommand
              ? {
                  kind: "text-slash",
                  body: input.textForCommands,
                  authorized: commandAuthorized,
                }
              : undefined,
            extra: {
              MessageSid: params.msg.messageSid,
              SenderE164: from,
              To: params.msg.to,
            },
          });
          return {
            cfg: params.cfg,
            channel: CHANNEL_ID,
            accountId: params.account.accountId,
            route: { agentId: route.agentId, sessionKey },
            ctxPayload,
            delivery: {
              durable: () => ({ to: from }),
              deliver: async (payload) => {
                if (!payload.text) {
                  return { visibleReplySent: false };
                }
                await sendRcsTextChunks({
                  account: params.account,
                  to: from,
                  text: payload.text,
                });
                return { visibleReplySent: true };
              },
            },
            dispatcherOptions: {
              onReplyStart: () => params.log?.info?.("RCS reply started"),
            },
          };
        },
      },
    });
    if (adoptionState === "pending" || adoptionState === "abandoned") {
      await materialized.cleanup();
    }
  } catch (error) {
    if (adoptionState === "pending" || adoptionState === "abandoned") {
      await materialized.cleanup();
    }
    throw error;
  }
}
