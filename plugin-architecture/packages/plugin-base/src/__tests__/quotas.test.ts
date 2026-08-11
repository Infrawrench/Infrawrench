import { describe, expect, it } from "vitest";
import { normalizeQuotaUsage, quotaUtilization, type QuotaUsage } from "../quotas.js";

function reading(over: Partial<QuotaUsage> = {}): QuotaUsage {
  return { id: "svc/A", service: "svc", name: "A", limit: 100, used: 50, ...over };
}

describe("normalizeQuotaUsage", () => {
  it("keeps a well-formed reading unchanged", () => {
    const input = reading({ region: "eu-west-1", unit: "vCPUs", adjustable: true });
    expect(normalizeQuotaUsage([input])).toEqual([input]);
  });

  // AWS returns Value: 0 for quotas that do not apply to an account and GCP
  // returns limit: -1 for unlimited. Both divide into a utilisation that is
  // either infinite or negative, and both sort straight to the top of a list
  // ordered by "closest to the ceiling".
  it("drops a limit that cannot be divided into", () => {
    expect(normalizeQuotaUsage([reading({ limit: 0 })])).toEqual([]);
    expect(normalizeQuotaUsage([reading({ limit: -1 })])).toEqual([]);
    expect(normalizeQuotaUsage([reading({ limit: Number.NaN })])).toEqual([]);
    expect(normalizeQuotaUsage([reading({ limit: Number.POSITIVE_INFINITY })])).toEqual([]);
  });

  it("drops a non-finite used rather than storing NaN", () => {
    expect(normalizeQuotaUsage([reading({ used: Number.NaN })])).toEqual([]);
  });

  // Clamping loses only the sign of a provider glitch; dropping the row would
  // also lose the limit.
  it("clamps a negative used to zero rather than dropping the row", () => {
    expect(normalizeQuotaUsage([reading({ used: -3 })])[0]?.used).toBe(0);
  });

  // Over-quota is a real state — a limit lowered under existing usage, a soft
  // limit the provider let through — and clamping it to 100% would hide the
  // one reading nobody should miss.
  it("keeps used > limit as-is", () => {
    expect(normalizeQuotaUsage([reading({ used: 140 })])[0]?.used).toBe(140);
  });

  // A duplicate id makes the snapshot's primary key ambiguous and the trend
  // jump between two unrelated series.
  it("keeps the first of a duplicated id", () => {
    const out = normalizeQuotaUsage([reading({ used: 10 }), reading({ used: 90 })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.used).toBe(10);
  });

  it("drops a reading with no id", () => {
    expect(normalizeQuotaUsage([reading({ id: "" })])).toEqual([]);
  });
});

describe("quotaUtilization", () => {
  it("is used over limit", () => {
    expect(quotaUtilization(80, 100)).toBeCloseTo(0.8);
  });

  it("is not clamped at 1", () => {
    expect(quotaUtilization(140, 100)).toBeCloseTo(1.4);
  });

  it("is zero rather than infinite for an unusable limit", () => {
    expect(quotaUtilization(5, 0)).toBe(0);
    expect(quotaUtilization(5, -1)).toBe(0);
  });
});
