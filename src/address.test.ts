import { describe, expect, it } from "vitest";
import {
  isRcsWireAddress,
  looksLikeRcsTarget,
  normalizeRcsAllowFrom,
  normalizeRcsIdentity,
  toRcsWireAddress,
} from "./address.js";

describe("RCS address normalization", () => {
  it("normalizes RCS and bare E.164 identities", () => {
    expect(normalizeRcsIdentity("RCS:+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeRcsIdentity("+15551234567")).toBe("+15551234567");
    expect(normalizeRcsIdentity("sms:+15551234567")).not.toBe("+15551234567");
  });

  it("builds and detects only RCS wire addresses", () => {
    expect(toRcsWireAddress("+15551234567")).toBe("rcs:+15551234567");
    expect(toRcsWireAddress("rcs:+15551234567")).toBe("rcs:+15551234567");
    expect(isRcsWireAddress("rcs:+15551234567")).toBe(true);
    expect(isRcsWireAddress("+15551234567")).toBe(false);
  });

  it("validates targets and allowlist entries", () => {
    expect(looksLikeRcsTarget("rcs:+15551234567")).toBe(true);
    expect(looksLikeRcsTarget("+01234567")).toBe(false);
    expect(normalizeRcsAllowFrom("rcs:+15551234567")).toBe("+15551234567");
    expect(normalizeRcsAllowFrom("*")).toBe("*");
  });
});
