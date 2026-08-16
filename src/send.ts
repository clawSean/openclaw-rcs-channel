// Rcs plugin module implements send behavior.
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import {
  chunkTextForOutbound,
  sanitizeAssistantVisibleText,
  stripMarkdown,
} from "openclaw/plugin-sdk/text-chunking";
import { recordInitialRcsDeliveryResult } from "./delivery-observations.js";
import { getRcsRuntime } from "./runtime.js";
import { sendRcsViaTwilio } from "./twilio.js";
import type { RcsSendResult, ResolvedRcsAccount } from "./types.js";

const RCS_TEXT_CHUNK_LIMIT = 1600;
type RcsMessageKind = "text" | "media";
type RcsDeliveryProgressResult = ChannelMessageSendResult & {
  channel: "rcs";
  messageId: string;
  chatId: string;
};
type RcsDeliveryProgress = (result: RcsDeliveryProgressResult) => Promise<void> | void;

export function createRcsChannelSendResult(params: {
  results: RcsSendResult[];
  kind: RcsMessageKind;
}): RcsDeliveryProgressResult {
  const first = params.results[0];
  if (!first) {
    throw new Error("RCS send did not return a Twilio Message SID.");
  }
  return {
    channel: "rcs",
    messageId: first.sid,
    chatId: first.to,
    receipt: createMessageReceiptFromOutboundResults({
      results: params.results.map((result) => ({
        channel: "rcs",
        messageId: result.sid,
        chatId: result.to,
        toJid: result.to,
        conversationId: result.to,
        meta: {
          ...(result.from ? { from: result.from } : {}),
          ...(result.status ? { status: result.status } : {}),
        },
      })),
      threadId: first.to,
      kind: params.kind,
    }),
  };
}

function throwRcsPartialDeliveryError(
  error: unknown,
  results: RcsSendResult[],
  kind: RcsMessageKind,
): never {
  if (results.length === 0) {
    throw error;
  }
  const completed = createRcsChannelSendResult({ results, kind });
  throw createChannelPartialDeliveryError(error, {
    messageIds: results.map((result) => result.sid),
    receipt: completed.receipt,
    visibleReplySent: true,
  });
}

async function recordInitialDeliveryBestEffort(
  account: ResolvedRcsAccount,
  result: RcsSendResult,
): Promise<void> {
  try {
    await recordInitialRcsDeliveryResult({ account, result });
  } catch (error) {
    try {
      getRcsRuntime()
        .logging.getChildLogger({ plugin: "rcs", feature: "delivery-status" })
        .warn("RCS delivery initial state could not be persisted.", {
          messageSid: result.sid,
          errorType: error instanceof Error ? error.name : typeof error,
        });
    } catch {
      // The provider send already succeeded. Observation persistence must not
      // turn that success into a resend or a user-visible send failure.
    }
  }
}

async function sendRcsProviderMessage(params: {
  account: ResolvedRcsAccount;
  to: string;
  text?: string;
  mediaUrls?: string[];
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<RcsSendResult> {
  let platformDispatchStarted = false;
  let result: RcsSendResult;
  try {
    result = await sendRcsViaTwilio({
      account: params.account,
      to: params.to,
      ...(params.text !== undefined ? { text: params.text } : {}),
      ...(params.mediaUrls !== undefined ? { mediaUrls: params.mediaUrls } : {}),
      onPlatformSendDispatch: async () => {
        // Twilio validates locally before this callback and performs HTTP after it.
        // Only failures before a persisted dispatch marker are proven safe to replay.
        await params.onPlatformSendDispatch?.();
        platformDispatchStarted = true;
      },
    });
  } catch (error) {
    if (platformDispatchStarted || error instanceof PlatformMessageNotDispatchedError) {
      throw error;
    }
    throw new PlatformMessageNotDispatchedError(
      `RCS send failed before Twilio dispatch: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  await recordInitialDeliveryBestEffort(params.account, result);
  return result;
}

export function toRcsPlainText(text: string): string {
  const visibleText = sanitizeAssistantVisibleText(text);
  const withoutFencedCodeMarkers = visibleText.replace(
    /```[^\n]*\n?([\s\S]*?)```/g,
    (_match, body: string) => body.trim(),
  );
  const withReadableLinks = withoutFencedCodeMarkers.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => {
      const cleanLabel = label.trim();
      const cleanUrl = url.trim();
      return cleanLabel && cleanLabel !== cleanUrl ? `${cleanLabel} (${cleanUrl})` : cleanUrl;
    },
  );
  return stripMarkdown(withReadableLinks)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendRcsTextChunks(params: {
  account: ResolvedRcsAccount;
  to: string;
  text: string;
  onPlatformSendDispatch?: () => Promise<void>;
  onDeliveryResult?: RcsDeliveryProgress;
}): Promise<RcsSendResult[]> {
  const text = toRcsPlainText(params.text);
  if (!text) {
    throw new Error("RCS send requires non-empty text.");
  }
  const chunks = chunkTextForOutbound(text, RCS_TEXT_CHUNK_LIMIT).filter(Boolean);
  const sendChunks = chunks.length ? chunks : [text];
  const results: RcsSendResult[] = [];
  try {
    for (const textLocal of sendChunks) {
      const result = await sendRcsProviderMessage({
        account: params.account,
        to: params.to,
        text: textLocal,
        onPlatformSendDispatch: params.onPlatformSendDispatch,
      });
      results.push(result);
      await params.onDeliveryResult?.(
        createRcsChannelSendResult({ results: [result], kind: "text" }),
      );
    }
  } catch (error) {
    throwRcsPartialDeliveryError(error, results, "text");
  }
  return results;
}

export async function sendRcsMedia(params: {
  account: ResolvedRcsAccount;
  to: string;
  mediaUrls: string[];
  text?: string;
  onPlatformSendDispatch?: () => Promise<void>;
  onDeliveryResult?: RcsDeliveryProgress;
}): Promise<RcsSendResult[]> {
  const remote = params.mediaUrls.filter((url) => /^https?:\/\//i.test(url));
  if (!remote.length) {
    throw new Error(
      "RCS outbound media requires publicly reachable http(s) URLs; local file hosting is not supported yet.",
    );
  }
  const text = params.text ? toRcsPlainText(params.text) : "";
  const results: RcsSendResult[] = [];
  try {
    const result = await sendRcsProviderMessage({
      account: params.account,
      to: params.to,
      ...(text ? { text } : {}),
      mediaUrls: remote,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
    });
    results.push(result);
    await params.onDeliveryResult?.(
      createRcsChannelSendResult({ results: [result], kind: "media" }),
    );
  } catch (error) {
    throwRcsPartialDeliveryError(error, results, "media");
  }
  return results;
}
