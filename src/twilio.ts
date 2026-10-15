import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseQueryString } from "node:querystring";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import { isRcsWireAddress, toRcsWireAddress } from "./address.js";
import { resolveRcsStatusCallbackUrl } from "./public-webhook-url.js";
import { requestTwilioApi, TwilioRcsApiError } from "./twilio-api.js";
import type {
  RcsInboundMedia,
  RcsInboundMessage,
  RcsSendResult,
  ResolvedRcsAccount,
} from "./types.js";

const TWILIO_ACCOUNTS_URL = "https://api.twilio.com/2010-04-01/Accounts";
const TWILIO_MESSAGING_URL = "https://messaging.twilio.com/v1";
const TWILIO_API_HOSTNAME = "api.twilio.com";
const TWILIO_MESSAGING_HOSTNAME = "messaging.twilio.com";
const WEBHOOK_BODY_LIMIT_BYTES = 32 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;
const MAX_INBOUND_MEDIA = 10;

type TwilioMessagePayload = {
  sid?: string;
  to?: string;
  from?: string;
  status?: string;
};

export type TwilioMessagingService = {
  sid: string;
  inboundRequestUrl: string;
  inboundMethod: string;
  useInboundWebhookOnNumber: boolean;
};

function firstString(value: unknown): string {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  return typeof value === "string" ? value : "";
}

function firstTrimmedString(value: unknown): string {
  return firstString(value).trim();
}

function parseTwilioSuccessPayload(text: string): TwilioMessagePayload {
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new Error("Twilio RCS send returned malformed JSON.");
    }
    const record = parsed;
    return {
      sid: typeof record.sid === "string" ? record.sid : undefined,
      to: typeof record.to === "string" ? record.to : undefined,
      from: typeof record.from === "string" ? record.from : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
    };
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Twilio RCS send returned malformed JSON.") {
      throw cause;
    }
    throw new Error("Twilio RCS send returned malformed JSON.", { cause });
  }
}

function requestSearch(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").search;
  } catch {
    return "";
  }
}

export function resolveTwilioWebhookSignatureUrl(params: {
  req: IncomingMessage;
  publicWebhookUrl: string;
}): string {
  const hashIndex = params.publicWebhookUrl.indexOf("#");
  const signatureBaseUrl =
    hashIndex === -1 ? params.publicWebhookUrl : params.publicWebhookUrl.slice(0, hashIndex);
  if (signatureBaseUrl.includes("?")) {
    return signatureBaseUrl;
  }
  const search = requestSearch(params.req);
  return search ? `${signatureBaseUrl}${search}` : signatureBaseUrl;
}

function parseTwilioFormBody(body: string): Record<string, string> {
  const parsed = parseQueryString(body);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = firstString(value);
  }
  return out;
}

function computeTwilioSignature(params: {
  url: string;
  authToken: string;
  form: Record<string, string>;
}): string {
  const data =
    params.url +
    Object.keys(params.form)
      .toSorted()
      .map((key) => `${key}${params.form[key] ?? ""}`)
      .join("");
  return createHmac("sha1", params.authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(params: {
  signature: string | undefined;
  url: string;
  authToken: string;
  form: Record<string, string>;
}): boolean {
  if (!params.signature || !params.url || !params.authToken) {
    return false;
  }
  return safeEqualSecret(
    params.signature,
    computeTwilioSignature({
      url: params.url,
      authToken: params.authToken,
      form: params.form,
    }),
  );
}

function collectInboundMedia(form: Record<string, string>): {
  media: RcsInboundMedia[];
  unavailableMediaCount: number;
} {
  const declaredCount = Number.parseInt(form.NumMedia ?? "0", 10);
  if (!Number.isSafeInteger(declaredCount) || declaredCount <= 0) {
    return { media: [], unavailableMediaCount: 0 };
  }
  const count = Math.min(declaredCount, MAX_INBOUND_MEDIA);
  const media: RcsInboundMedia[] = [];
  for (let index = 0; index < count; index += 1) {
    const url = firstTrimmedString(form[`MediaUrl${index}`]);
    if (!url) {
      continue;
    }
    const contentType = firstTrimmedString(form[`MediaContentType${index}`]);
    media.push({ url, ...(contentType ? { contentType } : {}) });
  }
  return {
    media,
    unavailableMediaCount: Math.max(0, declaredCount - media.length),
  };
}

export function buildTwilioInboundMessage(form: Record<string, string>): RcsInboundMessage | null {
  const accountSid = firstTrimmedString(form.AccountSid);
  const from = firstTrimmedString(form.From);
  const to = firstTrimmedString(form.To);
  const body = firstString(form.Body);
  const messageSid =
    firstTrimmedString(form.MessageSid) ||
    firstTrimmedString(form.SmsSid) ||
    firstTrimmedString(form.SmsMessageSid);
  const { media, unavailableMediaCount } = collectInboundMedia(form);
  if (
    !accountSid ||
    !from ||
    !to ||
    !isRcsWireAddress(from) ||
    !isRcsWireAddress(to) ||
    !messageSid ||
    (!body && media.length === 0 && unavailableMediaCount === 0)
  ) {
    return null;
  }
  return {
    accountSid,
    from,
    to,
    body,
    messageSid,
    media,
    ...(unavailableMediaCount > 0 ? { unavailableMediaCount } : {}),
    ...(firstTrimmedString(form.MessagingServiceSid)
      ? { messagingServiceSid: firstTrimmedString(form.MessagingServiceSid) }
      : {}),
  };
}

export async function readTwilioWebhookForm(req: IncomingMessage): Promise<Record<string, string>> {
  const body = await readRequestBodyWithLimit(req, {
    maxBytes: WEBHOOK_BODY_LIMIT_BYTES,
    timeoutMs: WEBHOOK_BODY_TIMEOUT_MS,
  });
  return parseTwilioFormBody(body);
}

export function respondTwiml(res: ServerResponse, statusCode: number, body = ""): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/xml; charset=utf-8");
  res.end(body || "<Response></Response>");
}

function twilioApiUrl(accountSid: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(
    `${TWILIO_ACCOUNTS_URL}/${encodeURIComponent(accountSid)}${normalizedPath}`,
  ).toString();
}

function twilioMessagingUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${TWILIO_MESSAGING_URL}${normalizedPath}`).toString();
}

function parseTwilioMessagingService(record: Record<string, unknown>): TwilioMessagingService {
  return {
    sid: firstTrimmedString(record.sid),
    inboundRequestUrl: firstTrimmedString(record.inbound_request_url ?? record.inboundRequestUrl),
    inboundMethod: firstTrimmedString(record.inbound_method ?? record.inboundMethod),
    useInboundWebhookOnNumber: Boolean(
      record.use_inbound_webhook_on_number ?? record.useInboundWebhookOnNumber,
    ),
  };
}

export async function retrieveTwilioMessagingService(params: {
  account: ResolvedRcsAccount;
  serviceSid: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TwilioMessagingService> {
  const response = await requestTwilioApi({
    account: params.account,
    url: twilioMessagingUrl(`/Services/${encodeURIComponent(params.serviceSid)}`),
    allowedHostname: TWILIO_MESSAGING_HOSTNAME,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  });
  if (!response.ok) {
    throw new TwilioRcsApiError(response.status, response.text, "messaging-service lookup");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Twilio Messaging Service lookup returned malformed JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("Twilio Messaging Service lookup returned malformed JSON.");
  }
  return parseTwilioMessagingService(parsed);
}

export async function sendRcsViaTwilio(params: {
  account: ResolvedRcsAccount;
  to: string;
  text?: string;
  mediaUrls?: string[];
  fetchImpl?: typeof fetch;
  onPlatformSendDispatch?: () => Promise<void>;
}): Promise<RcsSendResult> {
  if (!params.account.messagingServiceSid) {
    throw new Error("Twilio RCS send requires messagingServiceSid.");
  }
  if (!params.text && !(params.mediaUrls && params.mediaUrls.length)) {
    throw new Error("Twilio RCS send requires text or media.");
  }
  const statusCallback = resolveRcsStatusCallbackUrl(params.account.publicWebhookUrl);
  if (!statusCallback) {
    throw new Error("Twilio RCS send requires a valid publicWebhookUrl for status callbacks.");
  }
  const wireTo = toRcsWireAddress(params.to);
  const body = new URLSearchParams({
    To: wireTo,
    MessagingServiceSid: params.account.messagingServiceSid,
    StatusCallback: statusCallback,
  });
  if (params.text) {
    body.set("Body", params.text);
  }
  for (const mediaUrl of params.mediaUrls ?? []) {
    body.append("MediaUrl", mediaUrl);
  }
  await params.onPlatformSendDispatch?.();
  const response = await requestTwilioApi({
    account: params.account,
    url: twilioApiUrl(params.account.accountSid, "/Messages.json"),
    allowedHostname: TWILIO_API_HOSTNAME,
    init: {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    fetchImpl: params.fetchImpl,
  });
  if (!response.ok) {
    throw new TwilioRcsApiError(response.status, response.text);
  }
  const payload = parseTwilioSuccessPayload(response.text);
  const sid = payload.sid?.trim();
  if (!sid) {
    throw new Error("Twilio RCS send response did not include a Message SID.");
  }
  return {
    sid,
    to: payload.to?.trim() || wireTo,
    ...(payload.from?.trim() ? { from: payload.from.trim() } : {}),
    ...(payload.status?.trim() ? { status: payload.status.trim() } : {}),
  };
}
