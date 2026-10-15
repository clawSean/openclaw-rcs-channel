import { listRecentRcsDeliveryRecords, type RcsDeliveryRecord } from "./delivery-observations.js";
import { retrieveTwilioMessagingService, type TwilioMessagingService } from "./twilio.js";
import type { ResolvedRcsAccount } from "./types.js";

type DisplayLine = {
  text: string;
  tone?: "default" | "muted" | "success" | "warn" | "error";
};

type RcsTwilioWebhookProbe = {
  status:
    | "unavailable"
    | "messaging-service-missing"
    | "messaging-service-method-mismatch"
    | "messaging-service-url-mismatch"
    | "messaging-service-matches";
  reason?: string;
  serviceSid?: string;
  expectedUrl?: string;
  configuredUrl?: string;
  configuredMethod?: string;
};

export type RcsProbe = {
  ok: boolean;
  error?: string;
  webhook: RcsTwilioWebhookProbe;
  hints: string[];
};

function compareMessagingService(
  account: ResolvedRcsAccount,
  service: TwilioMessagingService,
): RcsTwilioWebhookProbe {
  if (service.useInboundWebhookOnNumber) {
    return {
      status: "unavailable",
      reason: "Disable defer-to-sender so RCS inbound uses the service-level webhook.",
    };
  }
  const shared = {
    serviceSid: service.sid || account.messagingServiceSid,
    expectedUrl: account.publicWebhookUrl,
    configuredUrl: service.inboundRequestUrl,
    configuredMethod: service.inboundMethod.toUpperCase(),
  };
  if (!service.inboundRequestUrl) {
    return { status: "messaging-service-missing", ...shared };
  }
  if (shared.configuredMethod && shared.configuredMethod !== "POST") {
    return { status: "messaging-service-method-mismatch", ...shared };
  }
  if (service.inboundRequestUrl !== account.publicWebhookUrl) {
    return { status: "messaging-service-url-mismatch", ...shared };
  }
  return { status: "messaging-service-matches", ...shared };
}

function webhookError(probe: RcsTwilioWebhookProbe): string | undefined {
  switch (probe.status) {
    case "messaging-service-matches":
      return undefined;
    case "unavailable":
      return probe.reason;
    case "messaging-service-missing":
      return "Twilio Messaging Service " + probe.serviceSid + " has no inbound request URL.";
    case "messaging-service-method-mismatch":
      return (
        "Twilio Messaging Service " +
        probe.serviceSid +
        " uses " +
        (probe.configuredMethod || "an unknown method") +
        "; use POST."
      );
    case "messaging-service-url-mismatch":
      return (
        "Twilio Messaging Service " +
        probe.serviceSid +
        " points at " +
        probe.configuredUrl +
        "; expected " +
        probe.expectedUrl +
        "."
      );
  }
  return undefined;
}

export async function probeRcsAccount(params: {
  account: ResolvedRcsAccount;
  timeoutMs: number;
  options?: { fetchImpl?: typeof fetch };
}): Promise<RcsProbe> {
  const webhook = params.account.messagingServiceSid
    ? compareMessagingService(
        params.account,
        await retrieveTwilioMessagingService({
          account: params.account,
          serviceSid: params.account.messagingServiceSid,
          fetchImpl: params.options?.fetchImpl,
          timeoutMs: params.timeoutMs,
        }),
      )
    : { status: "unavailable" as const, reason: "RCS probe requires messagingServiceSid." };
  const error = webhookError(webhook);
  return {
    ok: !error,
    ...(error ? { error } : {}),
    webhook,
    hints: [
      "RCS-only transport: recipients must be RCS-enabled and approved while the sender is in test mode.",
    ],
  };
}

function deliveryLine(
  receipt: Pick<RcsDeliveryRecord, "messageSid" | "status" | "errorCode">,
): DisplayLine {
  if (receipt.errorCode) {
    return {
      text: "Latest receipt " + receipt.messageSid + " failed (error " + receipt.errorCode + ")",
      tone: "warn",
    };
  }
  const status = receipt.status.trim().toLowerCase();
  if (status === "read") {
    return { text: "Read receipt: recipient read " + receipt.messageSid, tone: "success" };
  }
  if (status === "delivered") {
    return { text: "Delivered: " + receipt.messageSid + " reached the recipient", tone: "muted" };
  }
  return {
    text: "Latest receipt " + receipt.messageSid + ": " + receipt.status,
    tone: "muted",
  };
}

export async function buildRcsDeliveryStatusLines(
  account: ResolvedRcsAccount,
): Promise<DisplayLine[]> {
  const [event] = await listRecentRcsDeliveryRecords(account, 1);
  return event ? [deliveryLine(event)] : [];
}

export function formatRcsProbeLines(probe: unknown): DisplayLine[] {
  if (!probe || typeof probe !== "object") {
    return [];
  }
  // SAFETY: fields remain optional and are individually type-checked before display.
  const value = probe as Partial<RcsProbe>;
  const lines: DisplayLine[] = [];
  if (value.ok === true) {
    lines.push({ text: "Probe: ok", tone: "success" });
  } else if (value.ok === false) {
    lines.push({
      text: "Probe: failed" + (value.error ? " (" + value.error + ")" : ""),
      tone: "error",
    });
  }
  if (value.webhook?.status === "messaging-service-matches") {
    lines.push({ text: "Twilio RCS webhook: " + value.webhook.configuredUrl });
  } else if (value.webhook?.status) {
    lines.push({ text: "Twilio RCS webhook: " + value.webhook.status, tone: "warn" });
  }
  for (const hint of value.hints ?? []) {
    lines.push({ text: hint, tone: "muted" });
  }
  return lines;
}
