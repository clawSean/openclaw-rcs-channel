import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedRcsAccount } from "./types.js";
import { createRcsWebhookHandler } from "./webhook.js";

function parseTwilioFormBody(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

function createAccount(overrides: Partial<ResolvedRcsAccount> = {}): ResolvedRcsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    messagingServiceSid: "MG123",
    webhookPath: "/webhooks/rcs",
    publicWebhookUrl: "https://gateway.example.com/webhooks/rcs?configured=%2B#rp=ct",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "allowlist",
    allowFrom: ["+15551234567"],
    ...overrides,
  };
}

function createQuotaAccount(scope: string, overrides: Partial<ResolvedRcsAccount> = {}) {
  return createAccount({
    accountId: scope,
    webhookPath: `/webhooks/rcs/${scope}`,
    publicWebhookUrl: `https://gateway.example.com/webhooks/rcs/${scope}?configured=%2B#rp=ct`,
    ...overrides,
  });
}

function computeSignature(params: {
  url: string;
  authToken?: string;
  form: Record<string, string>;
}): string {
  const data =
    params.url +
    Object.keys(params.form)
      .toSorted()
      .map((key) => `${key}${params.form[key] ?? ""}`)
      .join("");
  return createHmac("sha1", params.authToken ?? "secret")
    .update(data)
    .digest("base64");
}

function inboundBody(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    AccountSid: "AC123",
    MessagingServiceSid: "MG123",
    From: "rcs:+15551234567",
    To: "rcs:approved_agent",
    Body: "hello",
    MessageSid: "SM-inbound",
    ...overrides,
  }).toString();
}

function createRequest(params: {
  body: string;
  signature?: string;
  path?: string;
  remoteAddress?: string;
  forwardedFor?: string;
}): IncomingMessage {
  const req = Readable.from([params.body]) as IncomingMessage;
  req.method = "POST";
  req.url = params.path ?? "/webhooks/rcs?configured=%2B";
  req.headers = {
    "content-type": "application/x-www-form-urlencoded",
    ...(params.signature ? { "x-twilio-signature": params.signature } : {}),
    ...(params.forwardedFor ? { "x-forwarded-for": params.forwardedFor } : {}),
  };
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: params.remoteAddress ?? "203.0.113.10", localPort: 18789 },
  });
  return req;
}

function configureRequest(req: IncomingMessage): IncomingMessage {
  req.method = "POST";
  req.headers = {};
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: "203.0.113.20", localPort: 18789 },
  });
  return req;
}

function createFailingRequest(error: Error): IncomingMessage {
  return configureRequest(
    new Readable({
      read() {
        this.destroy(error);
      },
    }) as IncomingMessage,
  );
}

function createPendingRequest(): IncomingMessage {
  return configureRequest(new Readable({ read() {} }) as IncomingMessage);
}

function createSignedRequest(params: {
  body: string;
  account?: ResolvedRcsAccount;
  remoteAddress?: string;
}): IncomingMessage {
  const account = params.account ?? createAccount();
  const signatureUrl = account.publicWebhookUrl.split("#", 1)[0] ?? account.publicWebhookUrl;
  return createRequest({
    body: params.body,
    signature: computeSignature({
      url: signatureUrl,
      authToken: account.authToken,
      form: parseTwilioFormBody(params.body),
    }),
    remoteAddress: params.remoteAddress,
  });
}

type TestResponse = ServerResponse & {
  body?: string;
  headers: Map<string, string>;
  endMock: ReturnType<typeof vi.fn>;
};

function createResponse(): TestResponse {
  const headers = new Map<string, string>();
  const endMock = vi.fn(function (this: ServerResponse & { body?: string }, body?: string) {
    this.body = body;
    return this;
  });
  return {
    statusCode: 200,
    headers,
    setHeader: vi.fn((name: string, value: string | number | readonly string[]) => {
      headers.set(name.toLowerCase(), String(value));
      return undefined as never;
    }),
    end: endMock,
    endMock,
  } as unknown as TestResponse;
}

describe("single RCS Twilio webhook", () => {
  it("durably admits signed RCS ingress before acknowledging", async () => {
    const enqueue = vi.fn(async () => ({ duplicate: false }));
    const handler = createRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: { enqueue },
    });
    const body = inboundBody();
    const res = createResponse();
    await handler(createSignedRequest({ body }), res);
    expect(enqueue).toHaveBeenCalledWith(parseTwilioFormBody(body));
    expect(res.statusCode).toBe(200);
    expect(res.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
  });

  it("returns retryable 503 when durable ingress is unavailable", async () => {
    const handler = createRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: {
        enqueue: vi.fn(async () => {
          throw new Error("sqlite unavailable");
        }),
      },
    });
    const res = createResponse();
    await handler(createSignedRequest({ body: inboundBody() }), res);
    expect(res.statusCode).toBe(503);
    expect(res.headers.has("x-openclaw-delivery-accepted")).toBe(false);
  });

  it("delegates transient body-read failures to Gateway retry responses", async () => {
    const enqueue = vi.fn(async () => ({ duplicate: false }));
    const handler = createRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: { enqueue },
    });

    vi.useFakeTimers();
    try {
      const timeoutResponse = createResponse();
      const handling = handler(createPendingRequest(), timeoutResponse);
      const expected = expect(handling).rejects.toMatchObject({
        code: "REQUEST_BODY_TIMEOUT",
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await expected;
      expect(timeoutResponse.endMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    const failedResponse = createResponse();
    await expect(
      handler(createFailingRequest(new Error("read failed")), failedResponse),
    ).rejects.toThrow("read failed");
    expect(failedResponse.endMock).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures, accounts, services, and SMS-shaped traffic", async () => {
    const enqueue = vi.fn(async () => ({ duplicate: false }));
    const handler = createRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: { enqueue },
    });

    const invalidSignature = createResponse();
    await handler(createRequest({ body: inboundBody(), signature: "invalid" }), invalidSignature);
    expect(invalidSignature.statusCode).toBe(403);

    const wrongAccountBody = inboundBody({ AccountSid: "AC999" });
    const wrongAccount = createResponse();
    await handler(createSignedRequest({ body: wrongAccountBody }), wrongAccount);
    expect(wrongAccount.statusCode).toBe(403);

    const wrongServiceBody = inboundBody({ MessagingServiceSid: "MG999" });
    const wrongService = createResponse();
    await handler(createSignedRequest({ body: wrongServiceBody }), wrongService);
    expect(wrongService.statusCode).toBe(403);

    const missingServiceBody = inboundBody({ MessagingServiceSid: "" });
    const missingService = createResponse();
    await handler(createSignedRequest({ body: missingServiceBody }), missingService);
    expect(missingService.statusCode).toBe(403);

    const smsBody = inboundBody({ From: "+15551234567", To: "+15557654321" });
    const sms = createResponse();
    await handler(createSignedRequest({ body: smsBody }), sms);
    expect(sms.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not let an unsigned flood starve a later valid callback", async () => {
    const remoteAddress = "203.0.113.77";
    const enqueue = vi.fn(async () => ({ duplicate: false }));
    const warn = vi.fn();
    const handler = createRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: { enqueue },
      log: { warn },
    });
    for (let index = 0; index <= 300; index += 1) {
      const res = createResponse();
      await handler(
        createRequest({
          body: inboundBody({ MessageSid: `SM-invalid-${index}` }),
          signature: "invalid",
          remoteAddress,
        }),
        res,
      );
    }
    const valid = createResponse();
    await handler(
      createSignedRequest({ body: inboundBody({ MessageSid: "SM-valid" }), remoteAddress }),
      valid,
    );
    expect(valid.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("RCS webhook invalid-request rate limit exceeded");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(remoteAddress);
  });

  it("meters durable ingress per validated sender without throttling delivery callbacks", async () => {
    const account = createQuotaAccount("sender-quota");
    const enqueue = vi.fn(async () => ({ duplicate: false }));
    const warn = vi.fn();
    const record = vi.fn(async () => ({
      kind: "recorded" as const,
      duplicate: false,
      record: { status: "delivered" },
    }));
    const handler = createRcsWebhookHandler({
      cfg: {},
      account,
      ingress: { enqueue },
      delivery: { record } as never,
      log: { warn },
    });

    for (let index = 0; index < 30; index += 1) {
      const body = inboundBody({
        From: "RCS:+1 (555) 123-4567",
        MessageSid: `SM-sender-${index}`,
      });
      const res = createResponse();
      await handler(createSignedRequest({ body, account, remoteAddress: "203.0.113.30" }), res);
      expect(res.statusCode).toBe(200);
    }

    const overQuotaBody = inboundBody({ MessageSid: "SM-sender-over" });
    const overQuota = createResponse();
    await handler(
      createSignedRequest({ body: overQuotaBody, account, remoteAddress: "203.0.113.30" }),
      overQuota,
    );
    expect(overQuota.statusCode).toBe(429);
    expect(overQuota.headers.has("x-openclaw-delivery-accepted")).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(30);
    expect(warn).toHaveBeenCalledWith("RCS webhook callback rate limit exceeded");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("+15551234567"));

    const otherSenderBody = inboundBody({
      From: "rcs:+15559998888",
      MessageSid: "SM-other-sender",
    });
    const otherSender = createResponse();
    await handler(
      createSignedRequest({ body: otherSenderBody, account, remoteAddress: "203.0.113.30" }),
      otherSender,
    );
    expect(otherSender.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(31);

    const stillLimited = createResponse();
    await handler(
      createSignedRequest({ body: overQuotaBody, account, remoteAddress: "203.0.113.31" }),
      stillLimited,
    );
    expect(stillLimited.statusCode).toBe(429);
    expect(enqueue).toHaveBeenCalledTimes(31);

    const deliveryBody = new URLSearchParams({
      AccountSid: account.accountSid,
      MessageSid: "SM-outbound-after-sender-limit",
      MessageStatus: "delivered",
    }).toString();
    const delivery = createResponse();
    await handler(createSignedRequest({ body: deliveryBody, account }), delivery);
    expect(delivery.statusCode).toBe(200);
    expect(record).toHaveBeenCalledOnce();
  });

  it("bounds aggregate validated sender fan-out before durable admission", async () => {
    const account = createQuotaAccount("aggregate-quota");
    const enqueue = vi.fn(async () => ({ duplicate: false }));
    const record = vi.fn(async () => ({
      kind: "recorded" as const,
      duplicate: false,
      record: { status: "delivered" },
    }));
    const handler = createRcsWebhookHandler({
      cfg: {},
      account,
      ingress: { enqueue },
      delivery: { record } as never,
    });

    for (let index = 0; index < 300; index += 1) {
      const body = inboundBody({
        From: `rcs:+1555${index.toString().padStart(7, "0")}`,
        MessageSid: `SM-aggregate-${index}`,
      });
      const res = createResponse();
      await handler(createSignedRequest({ body, account }), res);
      expect(res.statusCode).toBe(200);
    }

    const overAggregateBody = inboundBody({
      From: "rcs:+15559999999",
      MessageSid: "SM-aggregate-over",
    });
    const overAggregate = createResponse();
    await handler(createSignedRequest({ body: overAggregateBody, account }), overAggregate);
    expect(overAggregate.statusCode).toBe(429);
    expect(overAggregate.headers.has("x-openclaw-delivery-accepted")).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(300);

    const deliveryBody = new URLSearchParams({
      AccountSid: account.accountSid,
      MessageSid: "SM-outbound-after-aggregate-limit",
      MessageStatus: "delivered",
    }).toString();
    const delivery = createResponse();
    await handler(createSignedRequest({ body: deliveryBody, account }), delivery);
    expect(delivery.statusCode).toBe(200);
    expect(record).toHaveBeenCalledOnce();
  });

  it("keeps validation-disabled ingress on the client-address quota", async () => {
    const account = createQuotaAccount("unsigned-quota", {
      dangerouslyDisableSignatureValidation: true,
    });
    const enqueue = vi.fn(async () => ({ duplicate: false }));
    const handler = createRcsWebhookHandler({
      cfg: {},
      account,
      ingress: { enqueue },
    });

    for (let index = 0; index < 30; index += 1) {
      const body = inboundBody({
        From: `rcs:+1555000${(1000 + index).toString()}`,
        MessageSid: `SM-unsigned-${index}`,
      });
      const res = createResponse();
      await handler(createSignedRequest({ body, account, remoteAddress: "203.0.113.40" }), res);
      expect(res.statusCode).toBe(200);
    }

    const overQuotaBody = inboundBody({
      From: "rcs:+15550009999",
      MessageSid: "SM-unsigned-over",
    });
    const overQuota = createResponse();
    await handler(
      createSignedRequest({ body: overQuotaBody, account, remoteAddress: "203.0.113.40" }),
      overQuota,
    );
    expect(overQuota.statusCode).toBe(429);
    expect(enqueue).toHaveBeenCalledTimes(30);
  });

  it("persists known outbound delivery/read callbacks on the same route", async () => {
    const enqueue = vi.fn(async () => ({ duplicate: false }));
    const record = vi.fn(async () => ({
      kind: "recorded" as const,
      duplicate: false,
      record: { status: "read" },
    }));
    const handler = createRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: { enqueue },
      delivery: { record } as never,
    });
    const body = new URLSearchParams({
      AccountSid: "AC123",
      MessageSid: "SM-outbound",
      MessageStatus: "delivered",
      EventType: "READ",
    }).toString();
    const res = createResponse();
    await handler(createSignedRequest({ body }), res);
    expect(record).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
  });

  it("ignores authenticated unknown MessageSids without corrupting receipt state", async () => {
    const handler = createRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: { enqueue: vi.fn(async () => ({ duplicate: false })) },
      delivery: {
        record: vi.fn(async () => ({ kind: "unknown-message" as const })),
      },
    });
    const body = "AccountSid=AC123&MessageSid=SM-unknown&MessageStatus=sent";
    const res = createResponse();
    await handler(createSignedRequest({ body }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers.has("x-openclaw-delivery-accepted")).toBe(false);
  });

  it("returns retryable 503 when receipt persistence fails", async () => {
    const handler = createRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: { enqueue: vi.fn(async () => ({ duplicate: false })) },
      delivery: {
        record: vi.fn(async () => {
          throw new Error("sqlite unavailable");
        }),
      },
    });
    const body = "AccountSid=AC123&MessageSid=SM-known&MessageStatus=sent";
    const res = createResponse();
    await handler(createSignedRequest({ body }), res);
    expect(res.statusCode).toBe(503);
    expect(res.headers.has("x-openclaw-delivery-accepted")).toBe(false);
  });
});
