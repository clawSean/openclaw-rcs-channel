import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getRcsRuntime } from "./runtime.js";
import type { RcsSendResult, ResolvedRcsAccount } from "./types.js";

const NAMESPACE = "twilio-rcs-delivery-observations-v1";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 5_000;
const MAX_OBSERVATIONS = 20;
const RANK: Readonly<Record<string, number>> = {
  accepted: 10,
  scheduled: 20,
  queued: 30,
  sending: 40,
  sent: 50,
  delivered: 60,
  read: 70,
};
const FAILURES = new Set(["undelivered", "failed", "canceled"]);
const INBOUND = new Set(["receiving", "received"]);

type Observation = {
  source: "api-response" | "callback";
  fingerprint: string;
  status: string;
  observedAt: number;
  errorCode?: string;
};

export type RcsDeliveryRecord = {
  accountId: string;
  accountSidHash: string;
  messageSid: string;
  status: string;
  firstObservedAt: number;
  lastObservedAt: number;
  errorCode?: string;
  conflict?: boolean;
  observations: Observation[];
};

export type RcsDeliveryRecorder = {
  record: (params: {
    account: ResolvedRcsAccount;
    form: Record<string, string>;
  }) => Promise<
    | { kind: "recorded"; duplicate: boolean; record: RcsDeliveryRecord }
    | { kind: "unknown-message" }
  >;
};

let cachedStore: PluginStateKeyedStore<RcsDeliveryRecord> | undefined;
let cachedRuntime: ReturnType<typeof getRcsRuntime> | undefined;

function trimmed(form: Record<string, string>, key: string): string {
  return form[key]?.trim() ?? "";
}

function messageSid(form: Record<string, string>): string {
  return trimmed(form, "MessageSid") || trimmed(form, "SmsSid") || trimmed(form, "SmsMessageSid");
}

function normalizeStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  return INBOUND.has(normalized) ? "" : normalized;
}

function callbackStatus(form: Record<string, string>): string {
  return trimmed(form, "EventType").toUpperCase() === "READ"
    ? "read"
    : normalizeStatus(trimmed(form, "MessageStatus") || trimmed(form, "SmsStatus"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordKey(account: ResolvedRcsAccount, sid: string): string {
  return sha256(account.accountId + "\n" + sha256(account.accountSid) + "\n" + sid);
}

function observationFingerprint(observation: {
  source: Observation["source"];
  messageSid: string;
  status: string;
  errorCode?: string;
}): string {
  return sha256(
    JSON.stringify([
      observation.source,
      observation.messageSid,
      observation.status,
      observation.errorCode ?? "",
    ]),
  );
}

function openStore(): PluginStateKeyedStore<RcsDeliveryRecord> {
  const runtime = getRcsRuntime();
  if (!cachedStore || cachedRuntime !== runtime) {
    cachedRuntime = runtime;
    cachedStore = runtime.state.openKeyedStore<RcsDeliveryRecord>({
      namespace: NAMESPACE,
      maxEntries: MAX_MESSAGES,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: RETENTION_MS,
    });
  }
  return cachedStore;
}

export function isTwilioRcsDeliveryStatusForm(form: Record<string, string>): boolean {
  return Boolean(callbackStatus(form));
}

function reducedStatus(
  current: RcsDeliveryRecord | undefined,
  next: Observation,
): Pick<RcsDeliveryRecord, "status" | "errorCode" | "conflict"> {
  if (!current) {
    return { status: next.status, ...(next.errorCode ? { errorCode: next.errorCode } : {}) };
  }
  if (current.status === "conflicted") {
    return {
      status: current.status,
      ...(current.errorCode ? { errorCode: current.errorCode } : {}),
      conflict: true,
    };
  }
  if (current.status === next.status) {
    const errorCode = current.errorCode ?? next.errorCode;
    return { status: current.status, ...(errorCode ? { errorCode } : {}) };
  }

  const currentFailure = FAILURES.has(current.status);
  const nextFailure = FAILURES.has(next.status);
  const currentDelivered = current.status === "delivered" || current.status === "read";
  const nextDelivered = next.status === "delivered" || next.status === "read";
  if ((currentFailure && (nextFailure || nextDelivered)) || (currentDelivered && nextFailure)) {
    const errorCode = next.errorCode ?? current.errorCode;
    return {
      status: "conflicted",
      ...(errorCode ? { errorCode } : {}),
      conflict: true,
    };
  }
  if (currentFailure || current.status === "read") {
    return {
      status: current.status,
      ...(current.errorCode ? { errorCode: current.errorCode } : {}),
    };
  }
  if (nextFailure || (RANK[next.status] ?? -1) > (RANK[current.status] ?? -1)) {
    return { status: next.status, ...(next.errorCode ? { errorCode: next.errorCode } : {}) };
  }
  return {
    status: current.status,
    ...(current.errorCode ? { errorCode: current.errorCode } : {}),
  };
}

function mergeRecord(params: {
  account: ResolvedRcsAccount;
  messageSid: string;
  current: RcsDeliveryRecord | undefined;
  observation: Observation;
}): RcsDeliveryRecord | undefined {
  if (
    params.current?.observations.some(
      (existing) => existing.fingerprint === params.observation.fingerprint,
    )
  ) {
    return undefined;
  }
  const reduced = reducedStatus(params.current, params.observation);
  return {
    accountId: params.account.accountId,
    accountSidHash: sha256(params.account.accountSid),
    messageSid: params.messageSid,
    status: reduced.status,
    firstObservedAt: params.current?.firstObservedAt ?? params.observation.observedAt,
    lastObservedAt: params.observation.observedAt,
    ...(reduced.errorCode ? { errorCode: reduced.errorCode } : {}),
    ...(reduced.conflict ? { conflict: true } : {}),
    observations: [...(params.current?.observations ?? []), params.observation].slice(
      -MAX_OBSERVATIONS,
    ),
  };
}

async function persist(params: {
  account: ResolvedRcsAccount;
  messageSid: string;
  observation: Observation;
  store: PluginStateKeyedStore<RcsDeliveryRecord>;
  requireExisting: boolean;
}): Promise<
  { kind: "recorded"; duplicate: boolean; record: RcsDeliveryRecord } | { kind: "unknown-message" }
> {
  if (!params.store.update) {
    throw new Error("RCS delivery observations require atomic plugin state updates.");
  }
  let record: RcsDeliveryRecord | undefined;
  let duplicate = false;
  let unknown = false;
  await params.store.update(recordKey(params.account, params.messageSid), (current) => {
    if (!current && params.requireExisting) {
      unknown = true;
      return undefined;
    }
    const next = mergeRecord({ ...params, current });
    if (!next) {
      duplicate = true;
      record = current;
      return undefined;
    }
    record = next;
    return next;
  });
  if (unknown) {
    return { kind: "unknown-message" };
  }
  if (!record) {
    throw new Error("RCS delivery observation was not persisted.");
  }
  return { kind: "recorded", duplicate, record };
}

export function createRcsDeliveryRecorder(
  store: PluginStateKeyedStore<RcsDeliveryRecord> = openStore(),
): RcsDeliveryRecorder {
  return {
    async record({ account, form }) {
      const sid = messageSid(form);
      const status = callbackStatus(form);
      if (!sid || !status) {
        throw new Error("Invalid Twilio RCS delivery status callback.");
      }
      const errorCode = trimmed(form, "ErrorCode");
      const observation: Observation = {
        source: "callback",
        fingerprint: observationFingerprint({
          source: "callback",
          messageSid: sid,
          status,
          ...(errorCode ? { errorCode } : {}),
        }),
        status,
        observedAt: Date.now(),
        ...(errorCode ? { errorCode } : {}),
      };
      return await persist({
        account,
        messageSid: sid,
        observation,
        store,
        requireExisting: true,
      });
    },
  };
}

export async function recordInitialRcsDeliveryResult(params: {
  account: ResolvedRcsAccount;
  result: RcsSendResult;
  nowMs?: number;
  store?: PluginStateKeyedStore<RcsDeliveryRecord>;
}): Promise<RcsDeliveryRecord> {
  const sid = params.result.sid.trim();
  if (!sid) {
    throw new Error("RCS delivery registration requires a Message SID.");
  }
  const status = normalizeStatus(params.result.status ?? "") || "accepted";
  const result = await persist({
    account: params.account,
    messageSid: sid,
    observation: {
      source: "api-response",
      fingerprint: observationFingerprint({ source: "api-response", messageSid: sid, status }),
      status,
      observedAt: params.nowMs ?? Date.now(),
    },
    store: params.store ?? openStore(),
    requireExisting: false,
  });
  if (result.kind !== "recorded") {
    throw new Error("RCS delivery result was not registered.");
  }
  return result.record;
}

export async function listRecentRcsDeliveryRecords(
  account: ResolvedRcsAccount,
  limit = 1,
  store: PluginStateKeyedStore<RcsDeliveryRecord> = openStore(),
): Promise<RcsDeliveryRecord[]> {
  if (limit <= 0) {
    return [];
  }
  const accountSidHash = sha256(account.accountSid);
  return (await store.entries())
    .map((entry) => entry.value)
    .filter(
      (record) =>
        record.accountId === account.accountId && record.accountSidHash === accountSidHash,
    )
    .toSorted((left, right) => right.lastObservedAt - left.lastObservedAt)
    .slice(0, limit);
}
