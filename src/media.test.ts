import { describe, expect, it, vi } from "vitest";
import { materializeRcsInboundMedia } from "./media.js";
import type { RcsInboundMessage, ResolvedRcsAccount } from "./types.js";

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    toInboundMediaFactsWithMetadata: vi.fn(async (media: unknown[]) => media),
  };
});

const account: ResolvedRcsAccount = {
  accountId: "default",
  enabled: true,
  accountSid: "AC123",
  authToken: "secret",
  messagingServiceSid: "MG123",
  webhookPath: "/webhooks/rcs",
  publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
  dangerouslyDisableSignatureValidation: false,
  dmPolicy: "pairing",
  allowFrom: [],
};

function message(url: string): RcsInboundMessage {
  return {
    messageSid: "SM123",
    accountSid: "AC123",
    from: "rcs:+15551234567",
    to: "rcs:approved_agent",
    body: "photo",
    media: [{ url, contentType: "image/png" }],
  };
}

describe("RCS inbound media", () => {
  it("downloads only the exact authenticated Twilio media resource", async () => {
    const saveRemoteMedia = vi.fn(async () => ({
      path: "/tmp/rcs-proof.png",
      size: 100,
      contentType: "image/png",
    }));
    const result = await materializeRcsInboundMedia({
      account,
      msg: message(
        "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME00000000000000000000000000000000",
      ),
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });
    expect(saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: { hostnameAllowlist: ["api.twilio.com"] },
        requestInit: expect.objectContaining({
          headers: expect.objectContaining({ authorization: expect.stringMatching(/^Basic /) }),
        }),
      }),
    );
    expect(result.media).toEqual([expect.objectContaining({ path: "/tmp/rcs-proof.png" })]);
  });

  it.each([
    "https://evil.example/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME00000000000000000000000000000000",
    "https://api.twilio.com/2010-04-01/Accounts/AC999/Messages/SM123/Media/ME00000000000000000000000000000000",
    "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM999/Media/ME00000000000000000000000000000000",
  ])("refuses an unbound provider media URL: %s", async (url) => {
    const saveRemoteMedia = vi.fn();
    const result = await materializeRcsInboundMedia({
      account,
      msg: message(url),
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });
    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result.media).toEqual([]);
    expect(result.body).toContain("attachment unavailable");
  });
});
