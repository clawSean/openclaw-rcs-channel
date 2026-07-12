// RCS tests cover gateway route registration.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectRcsStartupWarnings, registerRcsWebhookRoutes } from "./gateway.js";
import type { RcsChannelRuntime } from "./inbound.js";
import type { ResolvedRcsAccount } from "./types.js";

const registerPluginHttpRoute = vi.hoisted(() => vi.fn((_route: { path: string }) => vi.fn()));

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  createFixedWindowRateLimiter: () => ({
    clear: vi.fn(),
    isRateLimited: vi.fn(() => false),
    size: vi.fn(() => 0),
  }),
  readRequestBodyWithLimit: vi.fn(async () => ""),
  registerPluginHttpRoute,
}));

const registeredRoutes: Array<() => void> = [];

function createAccount(overrides: Partial<ResolvedRcsAccount> = {}): ResolvedRcsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    messagingServiceSid: "MG123",
    senderId: "",
    transport: "rcs-only",
    defaultTo: "",
    webhookPath: "/webhooks/rcs",
    publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
    sharedWebhookPath: "",
    sharedWebhookPublicUrl: "",
    smsForwardWebhookPath: "",
    statusCallbacks: true,
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 3000,
    ...overrides,
  };
}

describe("registerRcsWebhookRoutes", () => {
  beforeEach(() => {
    registerPluginHttpRoute.mockClear();
  });

  afterEach(() => {
    for (const unregister of registeredRoutes.toReversed()) {
      unregister();
    }
    registeredRoutes.length = 0;
  });

  it("registers regular, status, and shared Twilio webhook routes", () => {
    const unregister = registerRcsWebhookRoutes({
      cfg: {},
      account: createAccount({
        sharedWebhookPath: "/webhooks/sms",
        sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
        smsForwardWebhookPath: "/webhooks/sms/native",
      }),
      channelRuntime: {} as RcsChannelRuntime,
    });
    registeredRoutes.push(unregister);

    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(3);
    expect(registerPluginHttpRoute.mock.calls.map((call) => call[0].path)).toEqual([
      "/webhooks/rcs",
      "/webhooks/rcs/status",
      "/webhooks/sms",
    ]);
  });
});

describe("collectRcsStartupWarnings", () => {
  it("requires forwarding and signature config for shared Twilio webhooks", () => {
    expect(
      collectRcsStartupWarnings(createAccount({ sharedWebhookPath: "/webhooks/sms" })),
    ).toEqual(
      expect.arrayContaining([
        "- RCS: smsForwardWebhookPath is required when sharedWebhookPath is set.",
        "- RCS: sharedWebhookPublicUrl is required for shared Twilio webhook signature validation.",
      ]),
    );
  });

  it("requires the shared webhook path to differ from the dedicated RCS path", () => {
    expect(
      collectRcsStartupWarnings(
        createAccount({
          sharedWebhookPath: "/webhooks/rcs",
          sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/rcs",
          smsForwardWebhookPath: "/webhooks/sms/native",
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "- RCS: a sharedWebhookPath distinct from webhookPath is required; the shared Twilio route cannot replace the dedicated RCS route.",
      ]),
    );
  });

  it("requires the SMS forward path to differ from the shared webhook path", () => {
    expect(
      collectRcsStartupWarnings(
        createAccount({
          sharedWebhookPath: "/webhooks/sms",
          sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
          smsForwardWebhookPath: "webhooks/sms",
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "- RCS: an smsForwardWebhookPath distinct from sharedWebhookPath is required; forwarding the shared webhook to itself would loop.",
      ]),
    );
  });

  it("accepts a distinct shared webhook and forward path pair", () => {
    expect(
      collectRcsStartupWarnings(
        createAccount({
          sharedWebhookPath: "/webhooks/sms",
          sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
          smsForwardWebhookPath: "/webhooks/sms/native",
        }),
      ),
    ).toEqual([]);
  });
});
