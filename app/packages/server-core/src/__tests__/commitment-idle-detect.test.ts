import { describe, expect, it } from "vitest";

import {
  detectIdleCommitments,
  judgeIdleCommitment,
  type IdleCommitmentInput,
  type IdleCommitmentOptions,
} from "../commitments/idle-detect";

const WINDOW = { from: "2026-07-12", to: "2026-08-10" }; // 30 days inclusive

const OPTIONS: IdleCommitmentOptions = {
  thresholdPercent: 70,
  minMeasuredDays: 14,
  minWasteAmount: 50,
};

const DAY_MS = 86_400_000;

/** Every ISO day in an inclusive range — the "we collected this day" set. */
function daysIn(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let t = new Date(`${from}T00:00:00Z`).valueOf();
    t <= new Date(`${to}T00:00:00Z`).valueOf();
    t += DAY_MS
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

const ALL_DAYS = daysIn(WINDOW.from, WINDOW.to);

function commitment(over: Partial<IdleCommitmentInput> = {}): IdleCommitmentInput {
  return {
    accountId: "acct1",
    commitmentId: "sp-1",
    description: "1-yr Compute Savings Plan",
    kind: "savings_plan",
    state: "active",
    currency: "USD",
    // $1/hr → $24/day → $720 over 30 days.
    hourlyCommitmentAmount: 1,
    startDate: "2026-01-01T00:00:00Z",
    endDate: "2026-12-31T00:00:00Z",
    attributed: true,
    daysWithData: ALL_DAYS,
    deliveredAmount: 250, // ~35% of 720
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * The rule the whole feature stands on.
 * ------------------------------------------------------------------ */

describe("idle detection — a null utilization NEVER alerts", () => {
  it("skips a unit-denominated commitment rather than reading it as 0%", () => {
    // A GCP CUD commits vCPUs. Cost rows cannot say how many ran, and 0%
    // would get a healthy purchase cancelled.
    const verdict = judgeIdleCommitment(
      commitment({ hourlyCommitmentAmount: null, deliveredAmount: 0 }),
      WINDOW,
      OPTIONS,
    );
    expect(verdict).toBe("unit_denominated");
  });

  it("skips a window with no collected days rather than reading it as 0%", () => {
    const verdict = judgeIdleCommitment(
      commitment({ daysWithData: [], deliveredAmount: 0 }),
      WINDOW,
      OPTIONS,
    );
    expect(verdict).toBe("no_data_days");
  });

  it("skips a commitment whose term does not overlap the window", () => {
    const verdict = judgeIdleCommitment(
      commitment({
        startDate: "2026-09-01T00:00:00Z",
        endDate: "2027-09-01T00:00:00Z",
        deliveredAmount: 0,
      }),
      WINDOW,
      OPTIONS,
    );
    expect(verdict).toBe("no_active_days");
  });

  it("skips an account whose rows carry no commitment attribution", () => {
    // Delivered reads 0 for a plan that may be working perfectly — the
    // failure `feed.ts` reports as `unattributed_rows` rather than 0%.
    const verdict = judgeIdleCommitment(
      commitment({ attributed: false, deliveredAmount: 0 }),
      WINDOW,
      OPTIONS,
    );
    expect(verdict).toBe("unattributed_rows");
  });

  it("produces no findings at all for a batch of only-unmeasurable commitments", () => {
    const { findings, skipped } = detectIdleCommitments(
      [
        commitment({ commitmentId: "cud", hourlyCommitmentAmount: null, deliveredAmount: 0 }),
        commitment({ commitmentId: "nodata", daysWithData: [], deliveredAmount: 0 }),
        commitment({ commitmentId: "unattributed", attributed: false, deliveredAmount: 0 }),
      ],
      WINDOW,
      OPTIONS,
    );
    expect(findings).toHaveLength(0);
    expect(skipped.map((s) => s.reason).sort()).toEqual([
      "no_data_days",
      "unattributed_rows",
      "unit_denominated",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * A window, not a day.
 * ------------------------------------------------------------------ */

describe("idle detection — a weekend is not a finding", () => {
  it("does not fire on a weekday-only workload", () => {
    // 22 weekdays fully used, 8 weekend days idle → 22/30 = 73%, above the
    // 70% bar. This is the population that must stay quiet.
    const weekdays = ALL_DAYS.filter((day) => {
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      return dow !== 0 && dow !== 6;
    }).length;
    const verdict = judgeIdleCommitment(
      commitment({ deliveredAmount: weekdays * 24 }),
      WINDOW,
      OPTIONS,
    );
    expect(verdict).toBe("not_idle");
  });

  it("refuses to judge a window with too few collected days", () => {
    // Ten days of data out of thirty: the ratio may be honest but it is not
    // enough of the window to act on.
    const verdict = judgeIdleCommitment(
      commitment({ daysWithData: ALL_DAYS.slice(0, 10), deliveredAmount: 10 }),
      WINDOW,
      OPTIONS,
    );
    expect(verdict).toBe("insufficient_measured_days");
  });

  it("counts only the collected days in the obligation", () => {
    // 20 collected days × $24 = $480 obligation. $480 delivered is 100%, not
    // the 67% a 30-day denominator would have produced.
    const verdict = judgeIdleCommitment(
      commitment({ daysWithData: ALL_DAYS.slice(0, 20), deliveredAmount: 480 }),
      WINDOW,
      OPTIONS,
    );
    expect(verdict).toBe("not_idle");
  });
});

/* ------------------------------------------------------------------ *
 * Money, not a percentage.
 * ------------------------------------------------------------------ */

describe("idle detection — findings", () => {
  it("reports the wasted money alongside the percentage", () => {
    const verdict = judgeIdleCommitment(commitment(), WINDOW, OPTIONS);
    expect(typeof verdict).not.toBe("string");
    const finding = verdict as Exclude<typeof verdict, string>;
    expect(finding.obligationAmount).toBeCloseTo(720, 5);
    expect(finding.deliveredAmount).toBe(250);
    expect(finding.wastedAmount).toBeCloseTo(470, 5);
    expect(finding.utilization).toBeCloseTo(250 / 720, 5);
    expect(finding.measuredDays).toBe(30);
    expect(finding.missingDays).toBe(0);
  });

  it("stays quiet when the waste is below the money floor", () => {
    // 68% used of a $10 obligation — genuinely idle, and worth nothing.
    const verdict = judgeIdleCommitment(
      commitment({ hourlyCommitmentAmount: 0.01, deliveredAmount: 4.9 }),
      WINDOW,
      OPTIONS,
    );
    expect(verdict).toBe("waste_below_floor");
  });

  it("ignores queued and expired commitments", () => {
    expect(judgeIdleCommitment(commitment({ state: "queued" }), WINDOW, OPTIONS)).toBe(
      "not_active",
    );
    expect(judgeIdleCommitment(commitment({ state: "expired" }), WINDOW, OPTIONS)).toBe(
      "not_active",
    );
  });

  it("orders findings worst-waste first", () => {
    const { findings } = detectIdleCommitments(
      [
        commitment({ commitmentId: "small", hourlyCommitmentAmount: 1, deliveredAmount: 500 }),
        commitment({ commitmentId: "big", hourlyCommitmentAmount: 10, deliveredAmount: 500 }),
      ],
      WINDOW,
      OPTIONS,
    );
    expect(findings.map((f) => f.commitmentId)).toEqual(["big", "small"]);
  });
});
