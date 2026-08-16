import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRcsGatewayAccount } from "./gateway.js";
import type { RcsChannelRuntime } from "./inbound.js";
import type { ResolvedRcsAccount } from "./types.js";

const registerPluginHttpRoute = vi.hoisted(() => vi.fn(() => vi.fn()));
const abortCleanups: Array<() => void | Promise<void>> = [];
const waitUntilAbort = vi.hoisted(() =>
  vi.fn(async (_signal: AbortSignal, onAbort?: () => void | Promise<void>) => {
    if (onAbort) {
      abortCleanups.push(onAbort);
    }
  }),
);
const ingressStart = vi.hoisted(() => vi.fn());
const ingressPause = vi.hoisted(() => vi.fn(async () => undefined));
const ingressStop = vi.hoisted(() => vi.fn(async () => undefined));
const createRcsIngressSpool = vi.hoisted(() =>
  vi.fn(() => ({
    start: ingressStart,
    pause: ingressPause,
    stop: ingressStop,
    enqueue: vi.fn(async () => ({ duplicate: false })),
  })),
);

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({ waitUntilAbort }));
vi.mock("./ingress-spool.js", () => ({ createRcsIngressSpool }));
vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  createFixedWindowRateLimiter: () => ({ isRateLimited: vi.fn(() => false) }),
  isRequestBodyLimitError: vi.fn(() => false),
  readRequestBodyWithLimit: vi.fn(async () => ""),
  registerPluginHttpRoute,
  resolveRequestClientIp: vi.fn(() => "127.0.0.1"),
}));

function createAccount(overrides: Partial<ResolvedRcsAccount> = {}): ResolvedRcsAccount {
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
    ...overrides,
  };
}

type TestStatusSink = (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;

async function startRoute(account: ResolvedRcsAccount, statusSink?: TestStatusSink) {
  const params = {
    cfg: {},
    account,
    abortSignal: new AbortController().signal,
    channelRuntime: {} as RcsChannelRuntime,
    ...(statusSink ? { statusSink } : {}),
  };
  return await startRcsGatewayAccount(params as Parameters<typeof startRcsGatewayAccount>[0]);
}

beforeEach(() => {
  registerPluginHttpRoute.mockReset();
  registerPluginHttpRoute.mockImplementation(() => vi.fn());
  ingressStart.mockClear();
  ingressPause.mockClear();
  ingressStop.mockClear();
  createRcsIngressSpool.mockClear();
});

afterEach(async () => {
  for (const cleanup of abortCleanups.toReversed()) {
    await cleanup();
  }
  abortCleanups.length = 0;
});

describe("RCS gateway registration", () => {
  it("publishes ready and stopped around an active webhook route", async () => {
    const statusSink = vi.fn<TestStatusSink>();
    await startRoute(createAccount(), statusSink);

    expect(statusSink).toHaveBeenNthCalledWith(1, { lifecycle: "starting" });
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "ready", connected: true }),
    );
    expect(statusSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    );
  });

  it("publishes stopped for disabled accounts and blocked for invalid required config", async () => {
    const disabledSink = vi.fn<TestStatusSink>();
    await startRoute(createAccount({ enabled: false }), disabledSink);
    expect(disabledSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    );

    for (const { account, expectedError } of [
      {
        account: createAccount({ authToken: "" }),
        expectedError: "accountSid, authToken, and messagingServiceSid are required",
      },
      {
        account: createAccount({ publicWebhookUrl: "http://gateway.example.com/webhooks/rcs" }),
        expectedError: "a valid publicWebhookUrl is required",
      },
    ]) {
      const blockedSink = vi.fn<TestStatusSink>();
      await startRoute(account, blockedSink);
      expect(blockedSink).toHaveBeenLastCalledWith(
        expect.objectContaining({
          lifecycle: "blocked",
          lastError: expect.stringContaining(expectedError),
          terminalDisconnect: true,
        }),
      );
    }
    expect(registerPluginHttpRoute).not.toHaveBeenCalled();
  });

  it("registers exactly one fail-fast route for messages and receipts", async () => {
    await startRoute(createAccount());
    expect(registerPluginHttpRoute).toHaveBeenCalledOnce();
    expect(registerPluginHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/webhooks/rcs",
        pluginId: "rcs",
        accountId: "default",
        throwOnFailure: true,
      }),
    );
    expect(ingressStart).toHaveBeenCalledOnce();
  });

  it("fails startup and stops ingress when the route is already owned", async () => {
    const statusSink = vi.fn<TestStatusSink>();
    registerPluginHttpRoute.mockImplementation(() => {
      throw new Error("plugin: route conflict at /webhooks/rcs");
    });
    await expect(startRoute(createAccount(), statusSink)).rejects.toThrow(/route conflict/);
    expect(ingressStart).not.toHaveBeenCalled();
    expect(ingressStop).toHaveBeenCalledOnce();
    expect(statusSink).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lifecycle: "blocked",
        lastError: expect.stringContaining("route conflict"),
        terminalDisconnect: true,
      }),
    );
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

  it("does not register an incomplete account", async () => {
    await startRoute(createAccount({ messagingServiceSid: "" }));
    expect(registerPluginHttpRoute).not.toHaveBeenCalled();
    expect(createRcsIngressSpool).not.toHaveBeenCalled();
  });

  it("does not register an account with a plaintext public webhook URL", async () => {
    await startRoute(
      createAccount({ publicWebhookUrl: "http://gateway.example.com/webhooks/rcs" }),
    );
    expect(registerPluginHttpRoute).not.toHaveBeenCalled();
    expect(createRcsIngressSpool).not.toHaveBeenCalled();
  });
});
