import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRcsAccount } from "./types.js";

type SendModule = typeof import("./send.js");
let sendRcsMedia: SendModule["sendRcsMedia"];
let sendRcsTextChunks: SendModule["sendRcsTextChunks"];
let toRcsPlainText: SendModule["toRcsPlainText"];

const sendRcsViaTwilio = vi.hoisted(() =>
  vi.fn(async ({ to, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return { sid: `SM-${to}`, to, status: "queued" };
  }),
);
const recordInitialRcsDeliveryResult = vi.hoisted(() => vi.fn(async () => undefined));

beforeEach(async () => {
  vi.resetModules();
  sendRcsViaTwilio.mockClear();
  recordInitialRcsDeliveryResult.mockClear();
  vi.doMock("./twilio.js", () => ({ sendRcsViaTwilio }));
  vi.doMock("./delivery-observations.js", () => ({ recordInitialRcsDeliveryResult }));
  ({ sendRcsMedia, sendRcsTextChunks, toRcsPlainText } = await import("./send.js"));
});

afterEach(() => {
  vi.doUnmock("./twilio.js");
  vi.doUnmock("./delivery-observations.js");
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

describe("RCS sends", () => {
  it("splits at the fixed 1,600-character limit and registers each SID", async () => {
    await sendRcsTextChunks({ account, to: "+15551234567", text: "a".repeat(1601) });
    expect(sendRcsViaTwilio).toHaveBeenCalledTimes(2);
    expect(recordInitialRcsDeliveryResult).toHaveBeenCalledTimes(2);
  });

  it("preserves an accepted chunk when a later RCS dispatch fails", async () => {
    const failure = new Error("second chunk failed");
    const events: string[] = [];
    sendRcsViaTwilio
      .mockImplementationOnce(async ({ to, onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        events.push("send:first");
        return { sid: "SM-first", to, status: "accepted" };
      })
      .mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        events.push("send:second");
        throw failure;
      });
    const onDeliveryResult = vi.fn(async (result) => {
      events.push(`delivery:${result.messageId}`);
    });
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("dispatch");
    });

    let observed: unknown;
    try {
      await sendRcsTextChunks({
        account,
        to: "+15551234567",
        text: "a".repeat(1601),
        onPlatformSendDispatch,
        onDeliveryResult,
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult).toMatchObject({
      messageIds: ["SM-first"],
      visibleReplySent: true,
      receipt: { parts: [{ platformMessageId: "SM-first", kind: "text" }] },
    });
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "rcs",
        messageId: "SM-first",
        chatId: "+15551234567",
      }),
    );
    expect(events).toEqual([
      "dispatch",
      "send:first",
      "delivery:SM-first",
      "dispatch",
      "send:second",
    ]);
  });

  it("flattens markdown before sending", () => {
    expect(toRcsPlainText("**Hi** [docs](https://example.com)\n\n```bash\napprove 123\n```")).toBe(
      "Hi docs (https://example.com)\n\napprove 123",
    );
  });

  it("rejects local outbound media and records public media sends", async () => {
    await expect(
      sendRcsMedia({ account, to: "+15551234567", mediaUrls: ["/tmp/image.png"] }),
    ).rejects.toThrow(/publicly reachable/);
    await sendRcsMedia({
      account,
      to: "+15551234567",
      mediaUrls: ["https://cdn.example/image.png"],
    });
    expect(recordInitialRcsDeliveryResult).toHaveBeenCalledOnce();
  });
});
