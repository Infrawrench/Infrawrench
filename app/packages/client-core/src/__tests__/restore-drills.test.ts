import { describe, expect, it } from "vitest";

import {
  RESTORE_DRILL_LIMITS,
  drillStanding,
  formatRto,
  isEvidenceOfRecovery,
  summarizeDrills,
  validateRestoreDrill,
  type DrillCoverageRow,
  type RestoreDrill,
} from "../restore-drills";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const DAY = 86_400_000;

function drill(overrides: Partial<RestoreDrill> = {}): RestoreDrill {
  return {
    id: "d1",
    resourceId: "res-1",
    resourceName: "orders-db",
    accountId: "acct-1",
    accountName: "prod",
    performedAt: new Date(NOW - 10 * DAY).toISOString(),
    outcome: "verified",
    rtoMinutes: 45,
    restoredFrom: "snap-123",
    notes: null,
    performedByUserId: null,
    performedByName: null,
    createdAt: new Date(NOW - 10 * DAY).toISOString(),
    ...overrides,
  };
}

describe("isEvidenceOfRecovery", () => {
  it("counts only a verified drill", () => {
    // A restore that produced a running database nobody looked inside is how a
    // team discovers, mid-incident, that the dump had been empty for months.
    expect(isEvidenceOfRecovery("verified")).toBe(true);
    expect(isEvidenceOfRecovery("restored-unverified")).toBe(false);
    expect(isEvidenceOfRecovery("failed")).toBe(false);
    expect(isEvidenceOfRecovery("blocked")).toBe(false);
  });
});

describe("validateRestoreDrill", () => {
  const base = {
    resourceId: "res-1",
    performedAt: new Date(NOW - DAY).toISOString(),
    outcome: "verified" as const,
    rtoMinutes: 45,
  };

  it("accepts a sound drill", () => {
    expect(validateRestoreDrill(base)).toBeNull();
  });

  it("refuses a drill in the future", () => {
    // Always a typo, and it would sit at the top of the list claiming the
    // backup is fine.
    expect(
      validateRestoreDrill({ ...base, performedAt: new Date(Date.now() + DAY).toISOString() }),
    ).toContain("future");
  });

  it("requires a measured time on a verified drill", () => {
    // The RPO comes from the backup; the RTO can only come from somebody with
    // a stopwatch, which is the whole point of the exercise.
    expect(validateRestoreDrill({ ...base, rtoMinutes: null })).toContain("measured time");
  });

  it("refuses a restore time on a blocked drill", () => {
    // It never started, so a duration is meaningless — and a meaningless RTO
    // is the most dangerous number on this page.
    expect(validateRestoreDrill({ ...base, outcome: "blocked", rtoMinutes: 10 })).toContain(
      "never got that far",
    );
    expect(validateRestoreDrill({ ...base, outcome: "blocked", rtoMinutes: null })).toBeNull();
  });

  it("bounds the restore time", () => {
    expect(
      validateRestoreDrill({ ...base, rtoMinutes: RESTORE_DRILL_LIMITS.maxRtoMinutes + 1 }),
    ).toContain("migration");
    expect(validateRestoreDrill({ ...base, rtoMinutes: -1 })).toContain("positive");
  });
});

describe("drillStanding", () => {
  const opts = { now: NOW, validDays: 180 };

  it("is never with no drills at all", () => {
    expect(drillStanding([], opts)).toMatchObject({
      standing: "never",
      lastDrillAt: null,
      daysUntilStale: null,
    });
  });

  it("is verified within the window, with the measured RTO", () => {
    expect(drillStanding([drill()], opts)).toMatchObject({
      standing: "verified",
      verifiedRtoMinutes: 45,
      daysUntilStale: 170,
    });
  });

  it("goes stale once the window passes", () => {
    const old = drill({ performedAt: new Date(NOW - 200 * DAY).toISOString() });
    expect(drillStanding([old], opts)).toMatchObject({ standing: "stale" });
    expect(drillStanding([old], opts).daysUntilStale).toBeLessThan(0);
  });

  it("is never when the only drills restored without verifying", () => {
    // Evidence-wise this is the same as never having tried, and the list shows
    // the attempt beside it.
    expect(
      drillStanding([drill({ outcome: "restored-unverified", rtoMinutes: 30 })], opts),
    ).toMatchObject({ standing: "never", lastOutcome: "restored-unverified" });
  });

  it("lets a later failure outrank an earlier success", () => {
    // Somebody tried more recently than the last green tick and it did not
    // work; reporting this as verified because March went well is the reading
    // that gets a team hurt.
    const drills = [
      drill({ id: "old", performedAt: new Date(NOW - 30 * DAY).toISOString() }),
      drill({
        id: "new",
        performedAt: new Date(NOW - 2 * DAY).toISOString(),
        outcome: "failed",
        rtoMinutes: null,
      }),
    ];
    const standing = drillStanding(drills, opts);
    expect(standing.standing).toBe("failed");
    // The last success is still reported, so the page can say when it was.
    expect(standing.lastVerifiedAt).toBe(drills[0]!.performedAt);
  });

  it("does not let an earlier failure outrank a later success", () => {
    const drills = [
      drill({
        id: "old",
        performedAt: new Date(NOW - 30 * DAY).toISOString(),
        outcome: "failed",
        rtoMinutes: null,
      }),
      drill({ id: "new", performedAt: new Date(NOW - 2 * DAY).toISOString() }),
    ];
    expect(drillStanding(drills, opts).standing).toBe("verified");
  });

  it("sorts by when the drill was performed, not by input order", () => {
    // People write these up on Monday for a drill they ran on Saturday.
    const drills = [
      drill({ id: "b", performedAt: new Date(NOW - 2 * DAY).toISOString(), rtoMinutes: 20 }),
      drill({ id: "a", performedAt: new Date(NOW - 40 * DAY).toISOString(), rtoMinutes: 90 }),
    ];
    expect(drillStanding(drills.reverse(), opts).verifiedRtoMinutes).toBe(20);
  });
});

describe("summarizeDrills", () => {
  const row = (over: Partial<DrillCoverageRow>): DrillCoverageRow => ({
    resourceId: "r",
    resourceName: null,
    accountId: null,
    accountName: null,
    resourceTypeId: null,
    standing: "verified",
    lastDrillAt: null,
    lastOutcome: null,
    lastVerifiedAt: null,
    verifiedRtoMinutes: null,
    daysUntilStale: null,
    ...over,
  });

  it("counts each standing", () => {
    const summary = summarizeDrills([
      row({ standing: "verified", verifiedRtoMinutes: 30 }),
      row({ standing: "stale" }),
      row({ standing: "failed" }),
      row({ standing: "never" }),
    ]);
    expect(summary).toMatchObject({
      eligibleCount: 4,
      verifiedCount: 1,
      staleCount: 1,
      failedCount: 1,
      neverCount: 1,
    });
  });

  it("reports the worst and median RTO over verified rows only", () => {
    // A measurement from a drill that has since gone stale is a number about a
    // system that has changed underneath it.
    const summary = summarizeDrills([
      row({ standing: "verified", verifiedRtoMinutes: 30 }),
      row({ standing: "verified", verifiedRtoMinutes: 90 }),
      row({ standing: "verified", verifiedRtoMinutes: 60 }),
      row({ standing: "stale", verifiedRtoMinutes: 999 }),
    ]);
    expect(summary.worstRtoMinutes).toBe(90);
    expect(summary.medianRtoMinutes).toBe(60);
  });

  it("reports null rather than zero when nothing is verified", () => {
    const summary = summarizeDrills([row({ standing: "never" })]);
    expect(summary.worstRtoMinutes).toBeNull();
    expect(summary.medianRtoMinutes).toBeNull();
  });
});

describe("formatRto", () => {
  it("reads as a person would say it", () => {
    expect(formatRto(null)).toBe("—");
    expect(formatRto(45)).toBe("45m");
    expect(formatRto(60)).toBe("1h");
    expect(formatRto(200)).toBe("3h 20m");
    expect(formatRto(1440)).toBe("1d");
    expect(formatRto(1740)).toBe("1d 5h");
  });
});
