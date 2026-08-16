import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createFixedWindowRateLimiter,
  isRequestBodyLimitError,
  resolveRequestClientIp,
} from "openclaw/plugin-sdk/webhook-ingress";
import { normalizeRcsIdentity } from "./address.js";
import {
  createRcsDeliveryRecorder,
  isTwilioRcsDeliveryStatusForm,
  type RcsDeliveryRecorder,
} from "./delivery-observations.js";
import {
  buildTwilioInboundMessage,
  readTwilioWebhookForm,
  respondTwiml,
  resolveTwilioWebhookSignatureUrl,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedRcsAccount } from "./types.js";

const INVALID_REQUEST_MAX_REQUESTS = 300;
const INBOUND_DISPATCH_MAX_REQUESTS = 30;
const VALIDATED_INBOUND_AGGREGATE_MAX_REQUESTS = 300;
const DELIVERY_CALLBACK_MAX_REQUESTS = 3_000;
const DELIVERY_CALLBACK_WINDOW_MS = 60_000;
const RCS_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const RCS_WEBHOOK_ACCEPTED_VALUE = "durable";

const invalidRequestRateLimiter = createFixedWindowRateLimiter({
  maxRequests: INVALID_REQUEST_MAX_REQUESTS,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});
const inboundDispatchRateLimiter = createFixedWindowRateLimiter({
  maxRequests: INBOUND_DISPATCH_MAX_REQUESTS,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});
const validatedInboundAggregateRateLimiter = createFixedWindowRateLimiter({
  maxRequests: VALIDATED_INBOUND_AGGREGATE_MAX_REQUESTS,
  windowMs: 60_000,
  maxTrackedKeys: 1_000,
});

type RcsWebhookLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type RcsWebhookHandlerParams = {
  cfg: OpenClawConfig;
  account: ResolvedRcsAccount;
  ingress: {
    enqueue: (form: Record<string, string>) => Promise<{ duplicate: boolean }>;
  };
  delivery?: RcsDeliveryRecorder;
  log?: RcsWebhookLog;
};

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolvedClientAddress(params: { cfg: OpenClawConfig; req: IncomingMessage }): string {
  return (
    resolveRequestClientIp(
      params.req,
      params.cfg.gateway?.trustedProxies,
      params.cfg.gateway?.allowRealIpFallback === true,
    ) ??
    params.req.socket?.remoteAddress ??
    "unknown"
  );
}

function rateLimitKey(params: { account: ResolvedRcsAccount; subject: string }): string {
  return `${params.account.accountId}:${params.account.webhookPath}:${params.subject}`;
}

function accountRouteRateLimitKey(account: ResolvedRcsAccount): string {
  return `${account.accountId}:${account.webhookPath}`;
}

function rejectInvalidRequestRateLimit(params: { log?: RcsWebhookLog; res: ServerResponse }): true {
  params.log?.warn?.("RCS webhook invalid-request rate limit exceeded");
  respondTwiml(params.res, 429, "Rate limit exceeded");
  return true;
}

export function createRcsWebhookHandler(params: RcsWebhookHandlerParams) {
  let deliveryRecorder = params.delivery;
  const deliveryCallbackRateLimiter = createFixedWindowRateLimiter({
    maxRequests: DELIVERY_CALLBACK_MAX_REQUESTS,
    windowMs: DELIVERY_CALLBACK_WINDOW_MS,
    maxTrackedKeys: 1,
  });
  const deliveryCallbackKey = rateLimitKey({
    account: params.account,
    subject: "delivery-callbacks",
  });

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    const clientAddressKey = rateLimitKey({
      account: params.account,
      subject: resolvedClientAddress({ cfg: params.cfg, req }),
    });
    const invalidRequestRateLimited = invalidRequestRateLimiter.isRateLimited(clientAddressKey);

    let form: Record<string, string>;
    try {
      form = await readTwilioWebhookForm(req);
    } catch (error) {
      if (isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE")) {
        respondTwiml(res, 413, "Payload too large");
        return true;
      }
      // Let the Gateway convert body timeouts, closed connections, and unexpected
      // stream failures into retryable server responses instead of terminal 4xx.
      throw error;
    }

    if (!params.account.dangerouslyDisableSignatureValidation) {
      const signatureValid = verifyTwilioSignature({
        signature: headerValue(req.headers["x-twilio-signature"]),
        url: resolveTwilioWebhookSignatureUrl({
          req,
          publicWebhookUrl: params.account.publicWebhookUrl,
        }),
        authToken: params.account.authToken,
        form,
      });
      if (!signatureValid) {
        if (invalidRequestRateLimited) {
          return rejectInvalidRequestRateLimit({ log: params.log, res });
        }
        params.log?.warn?.("RCS webhook rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    } else if (invalidRequestRateLimited) {
      return rejectInvalidRequestRateLimit({ log: params.log, res });
    }

    if (!form.AccountSid || form.AccountSid !== params.account.accountSid) {
      params.log?.warn?.("RCS webhook rejected missing or mismatched Twilio AccountSid");
      respondTwiml(res, 403, "Invalid account");
      return true;
    }

    if (isTwilioRcsDeliveryStatusForm(form)) {
      if (deliveryCallbackRateLimiter.isRateLimited(deliveryCallbackKey)) {
        params.log?.warn?.("RCS delivery callback rate limit exceeded");
        respondTwiml(res, 503, "Service unavailable");
        return true;
      }
      deliveryRecorder ??= createRcsDeliveryRecorder();
      try {
        const verdict = await deliveryRecorder.record({ account: params.account, form });
        if (verdict.kind === "unknown-message") {
          params.log?.warn?.("RCS delivery callback ignored unknown outbound MessageSid");
          respondTwiml(res, 200);
          return true;
        }
        params.log?.info?.(
          verdict.duplicate
            ? "RCS delivery callback ignored duplicate"
            : `RCS delivery observation ${verdict.record.status} recorded`,
        );
        res.setHeader(RCS_WEBHOOK_ACCEPTED_HEADER, RCS_WEBHOOK_ACCEPTED_VALUE);
        respondTwiml(res, 200);
        return true;
      } catch (error) {
        params.log?.error?.(
          `RCS delivery callback persistence failed: ${error instanceof Error ? error.name : typeof error}`,
        );
        respondTwiml(res, 503, "Service unavailable");
        return true;
      }
    }

    const message = buildTwilioInboundMessage(form);
    if (!message) {
      respondTwiml(res, 400, "Missing RCS payload");
      return true;
    }
    if (message.messagingServiceSid !== params.account.messagingServiceSid) {
      params.log?.warn?.("RCS webhook rejected missing or mismatched MessagingServiceSid");
      respondTwiml(res, 403, "Invalid Messaging Service");
      return true;
    }

    // Twilio egress IPs are shared across senders, so authenticated callbacks
    // meter on the normalized signature-covered From identity. When validation
    // is disabled, From is untrusted and traffic stays on the client-address key.
    const dispatchKey = params.account.dangerouslyDisableSignatureValidation
      ? clientAddressKey
      : rateLimitKey({
          account: params.account,
          subject: normalizeRcsIdentity(message.from),
        });
    if (inboundDispatchRateLimiter.isRateLimited(dispatchKey)) {
      params.log?.warn?.("RCS webhook callback rate limit exceeded");
      respondTwiml(res, 429, "Rate limit exceeded");
      return true;
    }
    // Per-sender fairness does not bound a signed fan-out across many senders.
    // Keep a separate account-route ceiling before durable queue admission.
    if (!params.account.dangerouslyDisableSignatureValidation) {
      const aggregateKey = accountRouteRateLimitKey(params.account);
      if (validatedInboundAggregateRateLimiter.isRateLimited(aggregateKey)) {
        params.log?.warn?.(`RCS webhook aggregate rate limit exceeded for ${aggregateKey}`);
        respondTwiml(res, 429, "Rate limit exceeded");
        return true;
      }
    }

    // Accepted inbound traffic is committed to SQLite before acknowledgement.
    try {
      const verdict = await params.ingress.enqueue(form);
      if (verdict.duplicate) {
        params.log?.info?.("RCS webhook ignored replayed message");
      }
      res.setHeader(RCS_WEBHOOK_ACCEPTED_HEADER, RCS_WEBHOOK_ACCEPTED_VALUE);
      respondTwiml(res, 200);
      return true;
    } catch (error) {
      params.log?.error?.(
        `RCS durable admission failed: ${error instanceof Error ? error.name : typeof error}`,
      );
      respondTwiml(res, 503, "Service unavailable");
      return true;
    }
  };
}
