// Rcs plugin module tracks recent outbound delivery status events.
//
// Twilio posts message status callbacks (queued/sent/delivered/read/failed)
// to the status route; this in-memory ring keeps the most recent events per
// account so probes and logs can surface RCS delivery and read receipts.
import type { RcsStatusEvent } from "./types.js";

const MAX_EVENTS_PER_ACCOUNT = 50;

const eventsByAccount = new Map<string, RcsStatusEvent[]>();

export function recordRcsStatusEvent(accountId: string, event: RcsStatusEvent): void {
  const events = eventsByAccount.get(accountId) ?? [];
  const existingIndex = events.findIndex((entry) => entry.messageSid === event.messageSid);
  if (existingIndex !== -1) {
    events.splice(existingIndex, 1);
  }
  events.unshift(event);
  if (events.length > MAX_EVENTS_PER_ACCOUNT) {
    events.length = MAX_EVENTS_PER_ACCOUNT;
  }
  eventsByAccount.set(accountId, events);
}

export function listRcsStatusEvents(accountId: string): RcsStatusEvent[] {
  return [...(eventsByAccount.get(accountId) ?? [])];
}

export function resetRcsStatusEventsForTest(): void {
  eventsByAccount.clear();
}
