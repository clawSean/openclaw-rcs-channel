import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectRcsAccount,
  isRcsAccountConfigured,
  listRcsAccountIds,
  resolveRcsAccount,
} from "./accounts.js";

afterEach(() => vi.unstubAllEnvs());

describe("RCS account resolution", () => {
  it("resolves the fixed RCS-only account surface", () => {
    const account = resolveRcsAccount({
      channels: {
        rcs: {
          accountSid: " AC123 ",
          authToken: "secret",
          messagingServiceSid: " MG123 ",
          publicWebhookUrl: " https://gateway.example/webhooks/rcs ",
        },
      },
    });
    expect(account).toMatchObject({
      accountSid: "AC123",
      messagingServiceSid: "MG123",
      webhookPath: "/webhooks/rcs",
      publicWebhookUrl: "https://gateway.example/webhooks/rcs",
    });
    expect(isRcsAccountConfigured(account)).toBe(true);
    expect(account).not.toHaveProperty("transport");
    expect(account).not.toHaveProperty("senderId");
  });

  it("requires the dedicated Messaging Service", () => {
    const account = resolveRcsAccount({
      channels: { rcs: { accountSid: "AC123", authToken: "secret" } },
    });
    expect(isRcsAccountConfigured(account)).toBe(false);
  });

  it("requires a valid HTTPS public webhook URL before reporting configured", () => {
    const credentials = {
      accountSid: "AC123",
      authToken: "secret",
      messagingServiceSid: "MG123",
    };
    const missingUrlConfig = { channels: { rcs: credentials } };
    const plaintextUrlConfig = {
      channels: {
        rcs: {
          ...credentials,
          publicWebhookUrl: "http://gateway.example.com/webhooks/rcs",
        },
      },
    };

    expect(isRcsAccountConfigured(resolveRcsAccount(missingUrlConfig))).toBe(false);
    expect(inspectRcsAccount(missingUrlConfig)).toMatchObject({
      configured: false,
      signatureValidation: "missing-public-url",
    });
    expect(isRcsAccountConfigured(resolveRcsAccount(plaintextUrlConfig))).toBe(false);
    expect(inspectRcsAccount(plaintextUrlConfig)).toMatchObject({
      configured: false,
      signatureValidation: "missing-public-url",
    });
  });

  it("ignores blank Twilio environment fallbacks when discovering accounts", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "  ");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_RCS_MESSAGING_SERVICE_SID", "\t");
    expect(listRcsAccountIds({ channels: { rcs: { enabled: true } } })).toEqual([]);
  });
});
