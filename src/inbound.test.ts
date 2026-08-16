import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRcsInboundEvent, type RcsChannelRuntime } from "./inbound.js";
import type { RcsInboundMessage, ResolvedRcsAccount } from "./types.js";

const sendRcsTextChunks = vi.hoisted(() => vi.fn(async () => []));
const materializeRcsInboundMedia = vi.hoisted(() =>
  vi.fn<typeof import("./media.js").materializeRcsInboundMedia>(async () => ({
    body: "safe media",
    media: [],
    cleanup: vi.fn(async () => undefined),
  })),
);

vi.mock("./send.js", () => ({ sendRcsTextChunks }));
vi.mock("./media.js", () => ({ materializeRcsInboundMedia }));

const RCS_FROM = "+15551234567";
const RCS_SESSION_KEY = `agent:main:rcs:direct:${RCS_FROM}`;
type RcsInboundRunParams = Parameters<RcsChannelRuntime["inbound"]["run"]>[0];

const account: ResolvedRcsAccount = {
  accountId: "default",
  enabled: true,
  accountSid: "AC123",
  authToken: "secret",
  messagingServiceSid: "MG123",
  webhookPath: "/webhooks/rcs",
  publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
  dangerouslyDisableSignatureValidation: false,
  dmPolicy: "allowlist",
  allowFrom: [RCS_FROM],
};

function message(overrides: Partial<RcsInboundMessage> = {}): RcsInboundMessage {
  return {
    messageSid: "SM-inbound",
    accountSid: "AC123",
    messagingServiceSid: "MG123",
    from: `rcs:${RCS_FROM}`,
    to: "rcs:approved_agent",
    body: "hello",
    media: [],
    ...overrides,
  };
}

function createRuntime() {
  const run = vi.fn(async (params: RcsInboundRunParams) => {
    await params.turnAdoptionLifecycle?.onAdopted?.();
  });
  const buildContext = vi.fn(() => ({ SessionKey: RCS_SESSION_KEY }));
  const runtime = {
    commands: {
      shouldComputeCommandAuthorized: vi.fn((body: string) => body.startsWith("/")),
      isControlCommandMessage: vi.fn((body: string) => body.startsWith("/")),
    },
    pairing: {
      readAllowFromStore: vi.fn(async () => [] as string[]),
      upsertPairingRequest: vi.fn(async () => ({ code: "PAIR123", created: true })),
    },
    routing: {
      resolveAgentRoute: vi.fn(() => ({
        agentId: "main",
        accountId: "default",
        sessionKey: RCS_SESSION_KEY,
      })),
    },
    inbound: { run, buildContext },
    media: { saveRemoteMedia: vi.fn() },
    session: { resolveStorePath: vi.fn(), recordInboundSession: vi.fn() },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  } as unknown as RcsChannelRuntime;
  return { runtime, run, buildContext };
}

async function resolveTurn(params: {
  msg?: RcsInboundMessage;
  turnAdoptionLifecycle?: { onAdopted: () => void | Promise<void> };
}) {
  const mocks = createRuntime();
  const inbound = params.msg ?? message();
  await dispatchRcsInboundEvent({
    cfg: {},
    account,
    channelRuntime: mocks.runtime,
    msg: inbound,
    receivedAt: 1_700_000_000_123,
    ...(params.turnAdoptionLifecycle
      ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
      : {}),
  });
  const runParams = expectDefined(mocks.run.mock.calls[0]?.[0], "RCS inbound run parameters");
  const turn = await runParams.adapter.resolveTurn(
    expectDefined(await runParams.adapter.ingest(inbound), "RCS normalized turn input"),
    { kind: "message", canStartAgentTurn: true },
    {},
  );
  return { ...mocks, runParams, turn };
}

beforeEach(() => {
  sendRcsTextChunks.mockClear();
  materializeRcsInboundMedia.mockClear();
});

describe("RCS inbound dispatch", () => {
  it("builds a stable direct turn with the durable receipt timestamp", async () => {
    const { buildContext, turn } = await resolveTurn({});
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "SM-inbound",
        timestamp: 1_700_000_000_123,
        from: `rcs:${RCS_FROM}`,
        reply: { to: `rcs:${RCS_FROM}` },
        extra: expect.objectContaining({ MessageSid: "SM-inbound" }),
      }),
    );
    expect("route" in turn && turn.route.sessionKey).toBe(RCS_SESSION_KEY);
  });

  it("materializes authenticated media before exposing it to the agent", async () => {
    const cleanup = vi.fn(async () => undefined);
    materializeRcsInboundMedia.mockResolvedValueOnce({
      body: "photo",
      media: [{ path: "/safe/photo.png", contentType: "image/png" }],
      cleanup,
    });
    const turnAdoptionLifecycle = { onAdopted: vi.fn(async () => undefined) };
    const { buildContext } = await resolveTurn({
      msg: message({
        media: [
          {
            url: "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM-inbound/Media/ME00000000000000000000000000000000",
          },
        ],
      }),
      turnAdoptionLifecycle,
    });
    expect(materializeRcsInboundMedia).toHaveBeenCalledOnce();
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ bodyForAgent: "photo" }),
        media: [expect.objectContaining({ path: "/safe/photo.png" })],
      }),
    );
    expect(JSON.stringify(buildContext.mock.calls)).not.toContain("api.twilio.com");
    expect(turnAdoptionLifecycle.onAdopted).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("marks allowlisted slash commands as authorized text commands", async () => {
    const { buildContext } = await resolveTurn({ msg: message({ body: "/status" }) });
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        access: { commands: { authorized: true } },
        command: { kind: "text-slash", body: "/status", authorized: true },
      }),
    );
  });

  it("creates pairing challenges without logging the sender identifier", async () => {
    const runtime = createRuntime();
    const log = { info: vi.fn(), warn: vi.fn() };
    await dispatchRcsInboundEvent({
      cfg: {},
      account: { ...account, dmPolicy: "pairing", allowFrom: [] },
      channelRuntime: runtime.runtime,
      msg: message(),
      receivedAt: 1,
      log,
    });
    expect(log.info).toHaveBeenCalledWith("RCS pairing request created");
    expect(sendRcsTextChunks).toHaveBeenCalledWith(
      expect.objectContaining({ to: RCS_FROM, text: expect.stringContaining("PAIR123") }),
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(RCS_FROM);
  });
});
