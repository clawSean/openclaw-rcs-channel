import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRcsPublicWebhookUrl, resolveRcsStatusCallbackUrl } from "./public-webhook-url.js";
import type { TwilioRcsApiError } from "./twilio-api.js";
import {
  buildTwilioInboundMessage,
  resolveTwilioWebhookSignatureUrl,
  retrieveTwilioMessagingService,
  sendRcsViaTwilio,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedRcsAccount } from "./types.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

function createAccount(overrides: Partial<ResolvedRcsAccount> = {}): ResolvedRcsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    messagingServiceSid: "MG123",
    webhookPath: "/webhooks/rcs",
    publicWebhookUrl: "https://gateway.example.com/webhooks/rcs?token=x",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    ...overrides,
  };
}

function expectRequestBody(init: RequestInit | undefined): URLSearchParams {
  if (!(init?.body instanceof URLSearchParams)) {
    throw new Error("Expected URLSearchParams request body.");
  }
  return init.body;
}

afterEach(() => fetchWithSsrFGuardMock.mockReset());

describe("Twilio RCS inbound parsing", () => {
  it("accepts only RCS wire traffic with an exact account identity", () => {
    expect(
      buildTwilioInboundMessage({
        AccountSid: "AC123",
        MessagingServiceSid: "MG123",
        From: "rcs:+15551234567",
        To: "rcs:approved_agent",
        Body: "hello",
        MessageSid: "SM123",
      }),
    ).toMatchObject({
      accountSid: "AC123",
      messagingServiceSid: "MG123",
      from: "rcs:+15551234567",
      body: "hello",
      messageSid: "SM123",
    });
    expect(
      buildTwilioInboundMessage({
        AccountSid: "AC123",
        From: "+15551234567",
        To: "+15557654321",
        Body: "SMS fallback",
        MessageSid: "SM124",
      }),
    ).toBeNull();
  });

  it("collects bounded media metadata without exposing button payloads", () => {
    const message = buildTwilioInboundMessage({
      AccountSid: "AC123",
      From: "rcs:+15551234567",
      To: "rcs:approved_agent",
      Body: "",
      MessageSid: "SM125",
      NumMedia: "2",
      MediaUrl0:
        "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM125/Media/ME00000000000000000000000000000000",
      MediaContentType0: "image/png",
    });
    expect(message?.media).toEqual([expect.objectContaining({ contentType: "image/png" })]);
    expect(message?.unavailableMediaCount).toBe(1);
    expect(message).not.toHaveProperty("buttonPayload");
  });
});

describe("RCS webhook URL contracts", () => {
  it("keeps one callback endpoint and adds retry overrides in the fragment", () => {
    expect(
      resolveRcsStatusCallbackUrl("https://gateway.example.com/webhooks/rcs?token=x#rp=ct"),
    ).toBe("https://gateway.example.com/webhooks/rcs?token=x#rp=ct,rt,5xx&rt=5000&rc=1");
  });

  it("preserves valid existing overrides and rejects unsafe public URLs", () => {
    expect(
      resolveRcsStatusCallbackUrl("https://gateway.example.com/webhooks/rcs#rp=all&rt=8000&rc=2"),
    ).toBe("https://gateway.example.com/webhooks/rcs#rp=all&rt=8000&rc=2");
    expect(parseRcsPublicWebhookUrl("http://gateway.example.com/webhooks/rcs")).toBeUndefined();
    expect(resolveRcsStatusCallbackUrl("http://gateway.example.com/webhooks/rcs")).toBe("");
    expect(parseRcsPublicWebhookUrl("http://127.0.0.1/webhooks/rcs")).toBeUndefined();
    const credentialedUrl = ["https://user", ":", "pass", "@gateway.example/rcs"].join("");
    expect(parseRcsPublicWebhookUrl(credentialedUrl)).toBeUndefined();
  });

  it("strips fragments from signature input without reserializing query bytes", () => {
    const req = { url: "/webhooks/rcs?request=1" } as Parameters<
      typeof resolveTwilioWebhookSignatureUrl
    >[0]["req"];
    expect(
      resolveTwilioWebhookSignatureUrl({
        req,
        publicWebhookUrl: "https://gateway.example.com/webhooks/rcs?configured=%2B#rp=all",
      }),
    ).toBe("https://gateway.example.com/webhooks/rcs?configured=%2B");
  });
});

describe("Twilio RCS sends", () => {
  it("forces rcs:+E164 through the Messaging Service and same callback endpoint", async () => {
    const events: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      events.push("fetch");
      const body = expectRequestBody(init);
      expect(body.get("To")).toBe("rcs:+15551234567");
      expect(body.get("MessagingServiceSid")).toBe("MG123");
      expect(body.get("From")).toBeNull();
      expect(body.get("StatusCallback")).toBe(
        "https://gateway.example.com/webhooks/rcs?token=x#rp=ct,rt,5xx&rt=5000&rc=1",
      );
      return new Response(
        JSON.stringify({ sid: "SM1", to: "rcs:+15551234567", status: "accepted" }),
        { status: 201 },
      );
    });
    await expect(
      sendRcsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
        mediaUrls: ["https://cdn.example/image.png"],
        fetchImpl: fetchImpl as typeof fetch,
        onPlatformSendDispatch: async () => {
          events.push("dispatch");
        },
      }),
    ).resolves.toMatchObject({ sid: "SM1", status: "accepted" });
    expect(expectRequestBody(fetchImpl.mock.calls[0]?.[1]).getAll("MediaUrl")).toEqual([
      "https://cdn.example/image.png",
    ]);
    expect(events).toEqual(["dispatch", "fetch"]);
  });

  it("rejects direct sender mode and missing callback configuration before dispatch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      sendRcsViaTwilio({
        account: createAccount({ messagingServiceSid: "" }),
        to: "+15551234567",
        text: "hello",
        fetchImpl,
        onPlatformSendDispatch: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("messagingServiceSid");
    await expect(
      sendRcsViaTwilio({
        account: createAccount({ publicWebhookUrl: "" }),
        to: "+15551234567",
        text: "hello",
        fetchImpl,
        onPlatformSendDispatch: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("valid publicWebhookUrl");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts reflected Basic credentials at the surfaced error boundary", async () => {
    const account = createAccount();
    const basic = `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString(
      "base64",
    )}`;
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ code: 20003, message: `reflected ${basic} token=${account.authToken}` }),
          { status: 401 },
        ),
    );
    let caught: TwilioRcsApiError | undefined;
    try {
      await sendRcsViaTwilio({
        account,
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      });
    } catch (error) {
      caught = error as TwilioRcsApiError;
    }
    expect(caught?.message).not.toContain(basic);
    expect(caught?.message).not.toContain(account.authToken);
    expect(caught?.responseText).not.toContain(account.authToken);
    expect(caught?.twilioCode).toBe(20003);
  });

  it("bounds guarded error responses and releases the SSRF guard", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("upstream ".repeat(2_000), { status: 503 }),
      release,
    });
    await expect(
      sendRcsViaTwilio({ account: createAccount(), to: "+15551234567", text: "hello" }),
    ).rejects.toThrow(/truncated/);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("Twilio helpers", () => {
  it("retrieves the configured Messaging Service", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            sid: "MG123",
            inbound_request_url: "https://gateway.example.com/webhooks/rcs",
            inbound_method: "POST",
            use_inbound_webhook_on_number: false,
          }),
          { status: 200 },
        ),
    );
    await expect(
      retrieveTwilioMessagingService({
        account: createAccount(),
        serviceSid: "MG123",
        fetchImpl,
      }),
    ).resolves.toMatchObject({ sid: "MG123", inboundMethod: "POST" });
  });

  it("round-trips Twilio signature verification", () => {
    const form = Object.fromEntries(
      new URLSearchParams("Body=hi&From=rcs%3A%2B15551234567&MessageSid=SM1"),
    );
    const signature = "QYB6bLhZa+Zesj+IEnLcbIkL8bA=";
    expect(
      verifyTwilioSignature({
        signature,
        url: "https://gateway.example.com/webhooks/rcs",
        authToken: "secret",
        form,
      }),
    ).toBe(true);
  });
});
