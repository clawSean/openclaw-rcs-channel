import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createRcsDeliveryRecorder,
  isTwilioRcsDeliveryStatusForm,
  listRecentRcsDeliveryRecords,
  recordInitialRcsDeliveryResult,
  type RcsDeliveryRecord,
} from "./delivery-observations.js";
import { buildRcsDeliveryStatusLines } from "./status.js";
import type { ResolvedRcsAccount } from "./types.js";

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

function createStore(): PluginStateKeyedStore<RcsDeliveryRecord> {
  const values = new Map<string, RcsDeliveryRecord>();
  return {
    async update(
      key: string,
      updateValue: (current: RcsDeliveryRecord | undefined) => RcsDeliveryRecord | undefined,
    ) {
      const next = updateValue(values.get(key));
      if (!next) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({
        key,
        value,
        createdAt: value.lastObservedAt,
      }));
    },
  } as unknown as PluginStateKeyedStore<RcsDeliveryRecord>;
}

async function register(store: PluginStateKeyedStore<RcsDeliveryRecord>, status = "accepted") {
  return await recordInitialRcsDeliveryResult({
    account,
    result: { sid: "SM123", to: "rcs:+15551234567", status },
    nowMs: 1,
    store,
  });
}

describe("RCS delivery observations", () => {
  it("classifies callbacks and binds them to a registered outbound MessageSid", async () => {
    expect(isTwilioRcsDeliveryStatusForm({ MessageSid: "SM1", EventType: "READ" })).toBe(true);
    expect(isTwilioRcsDeliveryStatusForm({ MessageSid: "SM1", MessageStatus: "received" })).toBe(
      false,
    );
    const store = createStore();
    const recorder = createRcsDeliveryRecorder(store);
    await expect(
      recorder.record({ account, form: { MessageSid: "SM-unknown", MessageStatus: "sent" } }),
    ).resolves.toEqual({ kind: "unknown-message" });
    await register(store);
    await expect(
      recorder.record({ account, form: { MessageSid: "SM123", MessageStatus: "sent" } }),
    ).resolves.toMatchObject({ kind: "recorded", record: { status: "sent" } });
  });

  it("keeps read monotonic and detects incompatible terminal callbacks", async () => {
    const store = createStore();
    await register(store, "queued");
    const recorder = createRcsDeliveryRecorder(store);
    const forms: Array<Record<string, string>> = [
      { MessageSid: "SM123", MessageStatus: "delivered" },
      { MessageSid: "SM123", EventType: "READ" },
      { MessageSid: "SM123", MessageStatus: "sent" },
    ];
    for (const form of forms) {
      await recorder.record({ account, form });
    }
    await expect(listRecentRcsDeliveryRecords(account, 1, store)).resolves.toMatchObject([
      { status: "read" },
    ]);
    await recorder.record({
      account,
      form: { MessageSid: "SM123", MessageStatus: "failed", ErrorCode: "30006" },
    });
    await expect(listRecentRcsDeliveryRecords(account, 1, store)).resolves.toMatchObject([
      { status: "conflicted", conflict: true, errorCode: "30006" },
    ]);
  });

  it("deduplicates callbacks and surfaces persisted read state", async () => {
    const store = createStore();
    await register(store);
    const recorder = createRcsDeliveryRecorder(store);
    const form = { MessageSid: "SM123", EventType: "READ" };
    await recorder.record({ account, form });
    await expect(recorder.record({ account, form })).resolves.toMatchObject({ duplicate: true });
    const listRecent = vi.spyOn(
      await import("./delivery-observations.js"),
      "listRecentRcsDeliveryRecords",
    );
    listRecent.mockResolvedValueOnce(await listRecentRcsDeliveryRecords(account, 1, store));
    expect((await buildRcsDeliveryStatusLines(account))[0]).toMatchObject({ tone: "success" });
    listRecent.mockRestore();
  });
});
