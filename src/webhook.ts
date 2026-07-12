// Rcs plugin module implements webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { fetchConfiguredLocalOriginWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime-internal";
import {
  createFixedWindowRateLimiter,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import { isRcsWireAddress, normalizeRcsIdentity } from "./address.js";
import { dispatchRcsInboundEvent, type RcsChannelRuntime } from "./inbound.js";
import { recordRcsStatusEvent } from "./status-store.js";
import {
  buildTwilioInboundMessage,
  buildTwilioStatusEvent,
  parseTwilioFormBody,
  readTwilioWebhookForm,
  resolveRcsStatusCallbackUrl,
  respondTwiml,
  resolveTwilioWebhookSignatureUrl,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedRcsAccount } from "./types.js";

// Coarse guard only protects the process from abusive source IPs; Twilio and
// reverse proxies can legitimately multiplex many senders through one IP, so the
// trip response is classified after validation instead of failing closed upfront.
const INBOUND_IP_RATE_LIMIT_PER_MINUTE = 600;
// Sender traffic shaping happens only after Twilio auth/account validation.
const INBOUND_SENDER_RATE_LIMIT_PER_MINUTE = 30;
// Loopback forward to the local gateway's SMS webhook route; bounded so a stuck
// local route cannot hold Twilio's webhook connection open indefinitely.
const SHARED_SMS_FORWARD_TIMEOUT_MS = 10_000;

const rateLimiter = createFixedWindowRateLimiter({
  maxRequests: INBOUND_IP_RATE_LIMIT_PER_MINUTE,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});
const senderRateLimiter = createFixedWindowRateLimiter({
  maxRequests: INBOUND_SENDER_RATE_LIMIT_PER_MINUTE,
  windowMs: 60_000,
  maxTrackedKeys: 10_000,
});
const statusRateLimiter = createFixedWindowRateLimiter({
  maxRequests: 120,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});
const REPLAY_CACHE_TTL_MS = 10 * 60_000;
const REPLAY_CACHE_MAX_KEYS = 10_000;
const SHARED_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
const SHARED_WEBHOOK_BODY_TIMEOUT_MS = 5_000;
const replayCache = new Map<string, number>();

type RcsWebhookLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type RcsWebhookHandlerParams = {
  cfg: OpenClawConfig;
  account: ResolvedRcsAccount;
  channelRuntime: RcsChannelRuntime;
  log?: RcsWebhookLog;
};

export type RcsSharedWebhookHandlerParams = RcsWebhookHandlerParams & {
  sharedPublicWebhookUrl: string;
  smsForwardWebhookPath: string;
};

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function rateLimitKey(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

function rejectRateLimitedRequest(params: {
  scope: string;
  key: string;
  log?: RcsWebhookLog;
  res: ServerResponse;
}): true {
  params.log?.warn?.(`${params.scope} rate limit exceeded for ${params.key}`);
  respondTwiml(params.res, 429, "Rate limit exceeded");
  return true;
}

export function resetRcsWebhookRateLimiterForTest(): void {
  rateLimiter.clear();
}

function requestSearch(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").search;
  } catch {
    return "";
  }
}

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function formLooksRcs(form: Record<string, string>): boolean {
  return isRcsWireAddress(form.From ?? "") || isRcsWireAddress(form.To ?? "");
}

function rememberWebhookMessage(params: {
  accountId: string;
  messageSid: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  for (const [key, expiresAt] of replayCache) {
    if (expiresAt > now && replayCache.size <= REPLAY_CACHE_MAX_KEYS) {
      break;
    }
    replayCache.delete(key);
  }
  const key = `${params.accountId}:${params.messageSid}`;
  if ((replayCache.get(key) ?? 0) > now) {
    return false;
  }
  replayCache.set(key, now + REPLAY_CACHE_TTL_MS);
  return true;
}

export function resetRcsWebhookReplayCacheForTest(): void {
  replayCache.clear();
  rateLimiter.clear();
  senderRateLimiter.clear();
  statusRateLimiter.clear();
}

function verifyWebhookSignature(params: {
  req: IncomingMessage;
  form: Record<string, string>;
  account: ResolvedRcsAccount;
  signatureUrl: string;
}): boolean {
  return verifyTwilioSignature({
    signature: headerValue(params.req.headers["x-twilio-signature"]),
    url: params.signatureUrl,
    authToken: params.account.authToken,
    form: params.form,
  });
}

function dispatchVerifiedRcsForm(params: {
  cfg: OpenClawConfig;
  account: ResolvedRcsAccount;
  channelRuntime: RcsChannelRuntime;
  form: Record<string, string>;
  res: ServerResponse;
  log?: RcsWebhookLog;
  scope: string;
  rateLimited: boolean;
  rateLimitedKey: string;
}): void {
  const msg = buildTwilioInboundMessage(params.form);
  if (!msg) {
    if (params.rateLimited) {
      rejectRateLimitedRequest({
        scope: params.scope,
        key: params.rateLimitedKey,
        log: params.log,
        res: params.res,
      });
      return;
    }
    respondTwiml(params.res, 400, "Missing RCS payload");
    return;
  }
  if (msg.accountSid && msg.accountSid !== params.account.accountSid) {
    if (params.rateLimited) {
      rejectRateLimitedRequest({
        scope: params.scope,
        key: params.rateLimitedKey,
        log: params.log,
        res: params.res,
      });
      return;
    }
    params.log?.warn?.("RCS webhook rejected mismatched Twilio AccountSid");
    respondTwiml(params.res, 403, "Invalid account");
    return;
  }
  if (params.rateLimited) {
    if (params.account.dangerouslyDisableSignatureValidation) {
      // Without signature validation nothing distinguishes Twilio from an attacker,
      // so unauthenticated over-limit traffic keeps the fail-closed 429.
      rejectRateLimitedRequest({
        scope: params.scope,
        key: params.rateLimitedKey,
        log: params.log,
        res: params.res,
      });
      return;
    }
    // Ack before the replay cache remembers the SID so a Twilio redelivery of this
    // dropped message can still dispatch once the window clears.
    params.log?.warn?.(
      `${params.scope} rate limit exceeded for ${params.rateLimitedKey}; acknowledged validated callback ${msg.messageSid} without dispatch`,
    );
    respondTwiml(params.res, 200);
    return;
  }
  if (
    !rememberWebhookMessage({
      accountId: params.account.accountId,
      messageSid: msg.messageSid,
    })
  ) {
    params.log?.warn?.(`RCS webhook ignored replayed message ${msg.messageSid}`);
    respondTwiml(params.res, 200);
    return;
  }
  const senderKey = normalizeRcsIdentity(msg.from);
  if (senderKey && senderRateLimiter.isRateLimited(`${params.account.accountId}:${senderKey}`)) {
    params.log?.warn?.(`RCS webhook sender rate limit exceeded for ${senderKey}`);
    // Twilio does not retry messaging webhooks on non-2xx; acknowledge and drop so
    // one hot sender cannot turn rate limiting into webhook failure noise.
    respondTwiml(params.res, 200);
    return;
  }

  void dispatchRcsInboundEvent({
    cfg: params.cfg,
    account: params.account,
    msg,
    channelRuntime: params.channelRuntime,
    log: params.log,
  }).catch((err: unknown) => {
    params.log?.error?.(
      `RCS webhook dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  respondTwiml(params.res, 200);
}

async function forwardSharedSmsWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  body: string;
  smsForwardWebhookPath: string;
  log?: RcsWebhookLog;
}): Promise<void> {
  const localPort = params.req.socket.localPort;
  if (!localPort) {
    params.log?.error?.("RCS shared webhook could not determine local gateway port");
    respondTwiml(params.res, 502, "Gateway forwarding unavailable");
    return;
  }
  const forwardPath = `${normalizeWebhookPath(params.smsForwardWebhookPath)}${requestSearch(params.req)}`;
  const localOriginBaseUrl = `http://127.0.0.1:${localPort}`;
  const forwardUrl = `${localOriginBaseUrl}${forwardPath}`;
  let guarded: Awaited<ReturnType<typeof fetchConfiguredLocalOriginWithSsrFGuard>>;
  try {
    guarded = await fetchConfiguredLocalOriginWithSsrFGuard({
      url: forwardUrl,
      configuredLocalOriginBaseUrl: localOriginBaseUrl,
      auditContext: "rcs-shared-webhook-sms-forward",
      timeoutMs: SHARED_SMS_FORWARD_TIMEOUT_MS,
      init: {
        method: "POST",
        headers: {
          "content-type":
            headerValue(params.req.headers["content-type"]) ?? "application/x-www-form-urlencoded",
          ...(headerValue(params.req.headers["x-twilio-signature"])
            ? { "x-twilio-signature": headerValue(params.req.headers["x-twilio-signature"]) ?? "" }
            : {}),
        },
        body: params.body,
      },
    });
  } catch (err) {
    params.log?.error?.(`RCS shared webhook SMS forward failed: ${String(err)}`);
    respondTwiml(params.res, 502, "Gateway forwarding failed");
    return;
  }
  try {
    const forwarded = guarded.response;
    params.res.statusCode = forwarded.status;
    const contentType = forwarded.headers.get("content-type");
    if (contentType) {
      params.res.setHeader("content-type", contentType);
    }
    params.res.end(await forwarded.text());
  } finally {
    await guarded.release();
  }
}

export function createRcsWebhookHandler(params: RcsWebhookHandlerParams) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    // Twilio does not retry non-2xx message webhooks, so the trip response waits
    // until validation classifies the request: unauthenticated traffic keeps the
    // 429, while validated callbacks are acknowledged without dispatch.
    const key = rateLimitKey(req);
    const rateLimited = rateLimiter.isRateLimited(key);

    let form: Record<string, string>;
    try {
      form = await readTwilioWebhookForm(req);
    } catch {
      if (rateLimited) {
        return rejectRateLimitedRequest({ scope: "RCS webhook", key, log: params.log, res });
      }
      respondTwiml(res, 400, "Invalid request body");
      return true;
    }

    if (!params.account.dangerouslyDisableSignatureValidation) {
      const ok = verifyWebhookSignature({
        req,
        form,
        account: params.account,
        signatureUrl: resolveTwilioWebhookSignatureUrl({
          req,
          publicWebhookUrl: params.account.publicWebhookUrl,
        }),
      });
      if (!ok) {
        if (rateLimited) {
          return rejectRateLimitedRequest({ scope: "RCS webhook", key, log: params.log, res });
        }
        params.log?.warn?.("RCS webhook rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    }

    dispatchVerifiedRcsForm({
      cfg: params.cfg,
      account: params.account,
      channelRuntime: params.channelRuntime,
      form,
      res,
      log: params.log,
      scope: "RCS webhook",
      rateLimited,
      rateLimitedKey: key,
    });

    return true;
  };
}

export function createRcsSharedTwilioWebhookHandler(params: RcsSharedWebhookHandlerParams) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    // Twilio does not retry non-2xx message webhooks, so the trip response waits
    // until validation classifies the request: unauthenticated traffic keeps the
    // 429, while validated callbacks are acknowledged without dispatch or forward.
    const key = rateLimitKey(req);
    const rateLimited = rateLimiter.isRateLimited(key);

    let body: string;
    let form: Record<string, string>;
    try {
      body = await readRequestBodyWithLimit(req, {
        maxBytes: SHARED_WEBHOOK_BODY_LIMIT_BYTES,
        timeoutMs: SHARED_WEBHOOK_BODY_TIMEOUT_MS,
      });
      form = parseTwilioFormBody(body);
    } catch {
      if (rateLimited) {
        return rejectRateLimitedRequest({ scope: "RCS shared webhook", key, log: params.log, res });
      }
      respondTwiml(res, 400, "Invalid request body");
      return true;
    }

    if (!params.account.dangerouslyDisableSignatureValidation) {
      const ok = verifyWebhookSignature({
        req,
        form,
        account: params.account,
        signatureUrl: resolveTwilioWebhookSignatureUrl({
          req,
          publicWebhookUrl: params.sharedPublicWebhookUrl,
        }),
      });
      if (!ok) {
        if (rateLimited) {
          return rejectRateLimitedRequest({
            scope: "RCS shared webhook",
            key,
            log: params.log,
            res,
          });
        }
        params.log?.warn?.("RCS shared webhook rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    }

    if (!formLooksRcs(form)) {
      if (rateLimited) {
        if (params.account.dangerouslyDisableSignatureValidation) {
          return rejectRateLimitedRequest({
            scope: "RCS shared webhook",
            key,
            log: params.log,
            res,
          });
        }
        // The loopback SMS forward runs in this same process, so shedding load means
        // acknowledging the validated callback here instead of forwarding it.
        params.log?.warn?.(
          `RCS shared webhook rate limit exceeded for ${key}; acknowledged validated callback ${form.MessageSid ?? form.SmsMessageSid ?? "unknown"} without SMS forward`,
        );
        respondTwiml(res, 200);
        return true;
      }
      await forwardSharedSmsWebhook({
        req,
        res,
        body,
        smsForwardWebhookPath: params.smsForwardWebhookPath,
        log: params.log,
      });
      return true;
    }

    dispatchVerifiedRcsForm({
      cfg: params.cfg,
      account: params.account,
      channelRuntime: params.channelRuntime,
      form,
      res,
      log: params.log,
      scope: "RCS shared webhook",
      rateLimited,
      rateLimitedKey: key,
    });
    return true;
  };
}

export function createRcsStatusCallbackHandler(params: RcsWebhookHandlerParams) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    const key = rateLimitKey(req);
    if (statusRateLimiter.isRateLimited(key)) {
      respondTwiml(res, 429, "Rate limit exceeded");
      return true;
    }

    let form: Record<string, string>;
    try {
      form = await readTwilioWebhookForm(req);
    } catch {
      respondTwiml(res, 400, "Invalid request body");
      return true;
    }

    if (!params.account.dangerouslyDisableSignatureValidation) {
      const ok = verifyWebhookSignature({
        req,
        form,
        account: params.account,
        signatureUrl: resolveTwilioWebhookSignatureUrl({
          req,
          publicWebhookUrl: resolveRcsStatusCallbackUrl(params.account.publicWebhookUrl),
        }),
      });
      if (!ok) {
        params.log?.warn?.("RCS status callback rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    }

    const event = buildTwilioStatusEvent(form);
    if (!event) {
      respondTwiml(res, 400, "Missing status payload");
      return true;
    }
    recordRcsStatusEvent(params.account.accountId, event);
    params.log?.info?.(
      `RCS message ${event.messageSid} status=${event.status}${event.errorCode ? ` error=${event.errorCode}` : ""}`,
    );

    respondTwiml(res, 200);
    return true;
  };
}
