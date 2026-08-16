import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RcsChannelRuntime } from "./inbound.js";
import { createRcsIngressSpool } from "./ingress-spool.js";
import type { ResolvedRcsAccount } from "./types.js";

vi.mock("openclaw/plugin-sdk/webhook-request-guards", () => ({
  runDetachedWebhookWork: async <T>(run: () => Promise<T>) => await run(),
}));

type Payload = { version: 1; form: Record<string, string> };
type Deliver = NonNullable<Parameters<typeof createRcsIngressSpool>[0]["deliver"]>;
type Spool = ReturnType<typeof createRcsIngressSpool>;

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

const stateDirs: string[] = [];
const disposers: Array<() => void | Promise<void>> = [];

async function createStateDir(): Promise<string> {
  const stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-rcs-ingress-")));
  stateDirs.push(stateDir);
  return stateDir;
}

function queue(stateDir: string) {
  return createChannelIngressQueueForTests<Payload>({
    channelId: "rcs",
    accountId: account.accountId,
    stateDir,
  });
}

function form(messageSid: string): Record<string, string> {
  return {
    AccountSid: account.accountSid,
    MessagingServiceSid: account.messagingServiceSid,
    From: "rcs:+15551234567",
    To: "rcs:example_agent",
    Body: "hello",
    MessageSid: messageSid,
  };
}

function spool(params: { stateDir: string; deliver: Deliver }): Spool {
  const instance = createRcsIngressSpool({
    cfg: {},
    account,
    channelRuntime: {} as RcsChannelRuntime,
    queue: queue(params.stateDir),
    deliver: params.deliver,
  });
  disposers.push(instance.stop);
  return instance;
}

async function drain(instance: Spool): Promise<void> {
  instance.start();
  await instance.waitForIdle();
}

afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) {
    await dispose();
  }
  for (const stateDir of stateDirs.splice(0).toReversed()) {
    await rm(stateDir, { recursive: true, force: true });
  }
});

describe("createRcsIngressSpool", () => {
  it("recovers an acknowledged but uncompleted message after restart", async () => {
    const stateDir = await createStateDir();
    const first = spool({
      stateDir,
      deliver: vi.fn<Deliver>(async () => undefined),
    });
    await first.enqueue(form("SM-restart"));
    await first.stop();

    const deliver = vi.fn<Deliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    await drain(spool({ stateDir, deliver }));
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("persists completed MessageSid tombstones across duplicate delivery", async () => {
    const stateDir = await createStateDir();
    const deliver = vi.fn<Deliver>(async (_message, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const instance = spool({ stateDir, deliver });
    expect(await instance.enqueue(form("SM-completed"))).toMatchObject({
      kind: "accepted",
      duplicate: false,
    });
    await drain(instance);
    expect(await instance.enqueue(form("SM-completed"))).toMatchObject({
      kind: "completed",
      duplicate: true,
    });
    await instance.waitForIdle();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid payload", { MessageSid: "SM-invalid", From: "rcs:+15551234567" }],
    ["account mismatch", { ...form("SM-account"), AccountSid: "AC-other" }],
    ["missing service identity", { ...form("SM-service"), MessagingServiceSid: "" }],
  ])("dead-letters a permanent %s failure", async (_label, rawForm) => {
    const stateDir = await createStateDir();
    const deliver = vi.fn<Deliver>(async () => undefined);
    const instance = spool({ stateDir, deliver });
    await instance.enqueue(rawForm);
    await drain(instance);
    expect(await instance.enqueue(rawForm)).toMatchObject({ kind: "failed", duplicate: true });
    expect(deliver).not.toHaveBeenCalled();
  });
});
