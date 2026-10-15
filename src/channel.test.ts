import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedRcsAccount } from "./types.js";

type StartRcsGatewayAccount = typeof import("./gateway.js").startRcsGatewayAccount;
type SendRcsViaTwilio = typeof import("./twilio.js").sendRcsViaTwilio;

const startRcsGatewayAccount = vi.hoisted(() =>
  vi.fn<StartRcsGatewayAccount>(async () => undefined),
);
const sendRcsViaTwilio = vi.hoisted(() =>
  vi.fn<SendRcsViaTwilio>(async ({ to, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return { sid: "SM-channel-proof", to, status: "accepted" };
  }),
);

vi.mock("./gateway.js", () => ({
  collectRcsStartupWarnings: () => [],
  startRcsGatewayAccount,
}));

vi.mock("./twilio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twilio.js")>()),
  sendRcsViaTwilio,
}));

vi.mock("./delivery-observations.js", () => ({
  recordInitialRcsDeliveryResult: vi.fn(async () => undefined),
}));

import { rcsPlugin } from "./channel.js";

function createAccount(): ResolvedRcsAccount {
  return {
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
}

describe("RCS channel contract", () => {
  it("is an independent RCS-only channel", () => {
    expect(rcsPlugin.meta?.id).toBe("rcs");
    expect(rcsPlugin.messaging?.targetPrefixes).toEqual(["rcs"]);
    expect(rcsPlugin.capabilities?.media).toBe(true);
  });

  it("does not advertise rich presentation or a fallback payload path", () => {
    expect(rcsPlugin.outbound?.presentationCapabilities).toBeUndefined();
    expect(rcsPlugin.outbound?.renderPresentation).toBeUndefined();
    expect(rcsPlugin.outbound?.sendPayload).toBeUndefined();
  });

  it("exposes only the narrow v1 setup fields", () => {
    expect(rcsPlugin.setupContract?.metadata.fields.map((field) => field.key)).toEqual([
      "accountSid",
      "authToken",
      "messagingServiceSid",
      "webhookPath",
      "publicWebhookUrl",
      "dmPolicy",
      "allowFrom",
    ]);
  });

  it("forwards durable dispatch and delivery hooks to text sends", async () => {
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    const onDeliveryResult = vi.fn(async () => undefined);

    await rcsPlugin.message?.send?.text?.({
      cfg: {
        channels: {
          rcs: {
            accountSid: "AC123",
            authToken: "secret",
            messagingServiceSid: "MG123",
            publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
          },
        },
      },
      to: "+15551234567",
      text: "hello",
      onPlatformSendDispatch,
      onDeliveryResult,
    });

    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "rcs",
        messageId: "SM-channel-proof",
        chatId: "+15551234567",
      }),
    );
  });

  it("forwards durable dispatch and delivery hooks to media sends", async () => {
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    const onDeliveryResult = vi.fn(async () => undefined);

    await rcsPlugin.message?.send?.media?.({
      cfg: {
        channels: {
          rcs: {
            accountSid: "AC123",
            authToken: "secret",
            messagingServiceSid: "MG123",
            publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
          },
        },
      },
      to: "+15551234567",
      text: "caption",
      mediaUrl: "https://cdn.example/image.png",
      onPlatformSendDispatch,
      onDeliveryResult,
    });

    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "rcs",
        messageId: "SM-channel-proof",
        chatId: "+15551234567",
        receipt: expect.objectContaining({
          parts: [expect.objectContaining({ kind: "media" })],
        }),
      }),
    );
  });

  it("binds Gateway lifecycle patches to the started account", async () => {
    const patches: Array<{ accountId: string; lifecycle?: string }> = [];
    const ctx = createStartAccountContext({
      account: createAccount(),
      statusPatchSink: (next) => patches.push({ ...next }),
    });
    ctx.channelRuntime = createPluginRuntimeMock().channel;
    startRcsGatewayAccount.mockImplementationOnce(async (params) => {
      params.statusSink?.({ lifecycle: "starting" });
    });

    await rcsPlugin.gateway?.startAccount?.(ctx);

    expect(startRcsGatewayAccount).toHaveBeenCalledWith(
      expect.objectContaining({ statusSink: expect.any(Function) }),
    );
    expect(patches).toContainEqual(
      expect.objectContaining({
        accountId: "default",
        lifecycle: "starting",
      }),
    );
  });

  it("projects lifecycle from the runtime status record", async () => {
    const blocked = await rcsPlugin.status?.buildAccountSnapshot?.({
      cfg: {},
      account: createAccount(),
      runtime: {
        accountId: "default",
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: "RCS webhook route registration failed: route conflict",
      },
    });

    expect(blocked).toMatchObject({
      configured: true,
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: expect.stringContaining("route conflict"),
    });

    const ready = await rcsPlugin.status?.buildAccountSnapshot?.({
      cfg: {},
      account: createAccount(),
      runtime: {
        accountId: "default",
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: 123,
      },
    });

    expect(ready).toMatchObject({
      configured: true,
      connected: true,
      lifecycle: "ready",
      running: true,
      lastConnectedAt: 123,
    });
  });
});
