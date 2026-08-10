import { describe, expect, it } from "vitest";

import {
  LEASE_MIN_WARNING_GAP_MS,
  LEASE_WARN1_LEAD_MS,
  LEASE_WARN2_LEAD_MS,
  leaseOutcomeMessage,
  leaseWarningMessage,
  leaseWarningTargets,
  nextLeaseStep,
  type LeaseTimingState,
} from "../leases/timing";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const C = Date.parse("2026-08-01T00:00:00.000Z"); // createdAt

function state(overrides: Partial<LeaseTimingState> & { expiresAt: number }): LeaseTimingState {
  return { createdAt: C, firstWarningAt: null, finalWarningAt: null, ...overrides };
}

describe("leaseWarningTargets", () => {
  it("targets 72h and 24h before expiry on long leases", () => {
    const E = C + 30 * DAY;
    expect(leaseWarningTargets(C, E)).toEqual({
      warn1At: E - LEASE_WARN1_LEAD_MS,
      warn2At: E - LEASE_WARN2_LEAD_MS,
    });
  });

  it("compresses proportionally when the lease is shorter than the horizon", () => {
    // 48h lease: warnings at 2/3 (E − 16h) and 11/12 (E − 4h) of the lifetime.
    const E = C + 48 * HOUR;
    expect(leaseWarningTargets(C, E)).toEqual({ warn1At: E - 16 * HOUR, warn2At: E - 4 * HOUR });
  });

  it("warns immediately + at half-life when created inside the final window", () => {
    const E = C + 12 * HOUR;
    expect(leaseWarningTargets(C, E)).toEqual({ warn1At: C, warn2At: C + 6 * HOUR });
  });
});

describe("nextLeaseStep", () => {
  const E = C + 30 * DAY;

  it("waits until the first warning target, then warns", () => {
    expect(nextLeaseStep(state({ expiresAt: E }), C)).toEqual({
      kind: "wait",
      until: E - LEASE_WARN1_LEAD_MS,
    });
    expect(nextLeaseStep(state({ expiresAt: E }), E - LEASE_WARN1_LEAD_MS)).toEqual({
      kind: "warn1",
    });
  });

  it("walks warn1 → warn2 → delete on the normal timeline", () => {
    const warn1SentAt = E - LEASE_WARN1_LEAD_MS;
    const afterWarn1 = state({ expiresAt: E, firstWarningAt: warn1SentAt });
    expect(nextLeaseStep(afterWarn1, warn1SentAt)).toEqual({
      kind: "wait",
      until: E - LEASE_WARN2_LEAD_MS,
    });
    expect(nextLeaseStep(afterWarn1, E - LEASE_WARN2_LEAD_MS)).toEqual({ kind: "warn2" });

    const afterWarn2 = state({
      expiresAt: E,
      firstWarningAt: warn1SentAt,
      finalWarningAt: E - LEASE_WARN2_LEAD_MS,
    });
    expect(nextLeaseStep(afterWarn2, E - 1)).toEqual({ kind: "wait", until: E });
    expect(nextLeaseStep(afterWarn2, E)).toEqual({ kind: "delete" });
  });

  it("never deletes before both warnings, even past expiry", () => {
    // Poller was down; expiry passed with no warnings sent.
    const now = E + HOUR;
    expect(nextLeaseStep(state({ expiresAt: E }), now)).toEqual({ kind: "warn1" });

    // Warning 1 just went out — warning 2 is floored a minimum gap later.
    const afterLateWarn1 = state({ expiresAt: E, firstWarningAt: now });
    expect(nextLeaseStep(afterLateWarn1, now)).toEqual({
      kind: "wait",
      until: now + LEASE_MIN_WARNING_GAP_MS,
    });
    expect(nextLeaseStep(afterLateWarn1, now + LEASE_MIN_WARNING_GAP_MS)).toEqual({
      kind: "warn2",
    });

    // Both sent and expiry passed — only now is the delete due.
    const afterBoth = state({
      expiresAt: E,
      firstWarningAt: now,
      finalWarningAt: now + LEASE_MIN_WARNING_GAP_MS,
    });
    expect(nextLeaseStep(afterBoth, now + LEASE_MIN_WARNING_GAP_MS)).toEqual({ kind: "delete" });
  });

  it("buys a real gap when the first warning went out late", () => {
    // Warning 1 landed only 1h before expiry (long lease, poller downtime):
    // warning 2 waits half the remaining time, not the stale E−24h target.
    const warn1SentAt = E - HOUR;
    const s = state({ expiresAt: E, firstWarningAt: warn1SentAt });
    expect(nextLeaseStep(s, warn1SentAt)).toEqual({
      kind: "wait",
      until: warn1SentAt + HOUR / 2,
    });
  });

  it("keeps a short lease's warning order inside its lifetime", () => {
    const E12 = C + 12 * HOUR;
    expect(nextLeaseStep(state({ expiresAt: E12 }), C)).toEqual({ kind: "warn1" });
    const s = state({ expiresAt: E12, firstWarningAt: C });
    expect(nextLeaseStep(s, C + 5 * HOUR)).toEqual({ kind: "wait", until: C + 6 * HOUR });
    expect(nextLeaseStep(s, C + 6 * HOUR)).toEqual({ kind: "warn2" });
  });
});

describe("lease messages", () => {
  const lease = {
    displayName: "load-test-cluster",
    note: "Q3 launch load test",
    expiresAt: C + 3 * DAY,
  };

  it("names the resource, the deadline and the note in warnings", () => {
    const first = leaseWarningMessage("warn1", lease, C);
    expect(first.title).toContain("load-test-cluster");
    expect(first.title).toContain("approaching");
    expect(first.lines.join("\n")).toContain("Q3 launch load test");

    const final = leaseWarningMessage("warn2", lease, C + 3 * DAY - LEASE_WARN2_LEAD_MS);
    expect(final.title).toBe("Lease expiring: load-test-cluster will be auto-deleted in ~24h");
  });

  it("renders the completion outcomes", () => {
    expect(leaseOutcomeMessage("deleted", lease).title).toBe(
      "Lease expired: load-test-cluster was deleted",
    );
    const failed = leaseOutcomeMessage("failed", lease, "provider said no");
    expect(failed.title).toBe("Lease auto-delete failed: load-test-cluster");
    expect(failed.lines.join("\n")).toContain("provider said no");
  });
});
