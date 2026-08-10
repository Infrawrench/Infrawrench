import { describe, expect, it } from "vitest";

import {
  detectCommitmentExpiries,
  expiryBracket,
  type CommitmentExpiryOptions,
  type ExpiringCommitmentInput,
} from "../commitments/expiry-detect";

const TODAY = "2026-08-10";

const OPTIONS: CommitmentExpiryOptions = {
  horizonDays: [60, 30, 7],
  alertOnExpired: true,
  expiredLookbackDays: 90,
};

function commitment(over: Partial<ExpiringCommitmentInput> = {}): ExpiringCommitmentInput {
  return {
    accountId: "acct1",
    commitmentId: "ri-1",
    kind: "reservation",
    description: "m5.xlarge · eu-west-1",
    scope: "Shared",
    region: "eu-west-1",
    state: "active",
    startDay: "2025-08-10",
    endDay: "2026-09-09", // 30 days out
    currency: "USD",
    hourlyCommitmentAmount: 1.5,
    unitCommitments: null,
    autoRenew: null,
    deliveredAmount: 1200,
    measuredDays: 30,
    ...over,
  };
}

describe("expiryBracket — the smallest horizon reached", () => {
  it("picks the widest horizon while the term is still far out", () => {
    expect(expiryBracket(45, [7, 30, 60])).toBe(60);
  });

  it("tightens as the term shortens", () => {
    expect(expiryBracket(30, [7, 30, 60])).toBe(30);
    expect(expiryBracket(8, [7, 30, 60])).toBe(30);
    expect(expiryBracket(7, [7, 30, 60])).toBe(7);
    expect(expiryBracket(1, [7, 30, 60])).toBe(7);
  });

  it("is null while the term is beyond every horizon", () => {
    expect(expiryBracket(61, [7, 30, 60])).toBeNull();
  });
});

describe("detectCommitmentExpiries — fire once per horizon", () => {
  it("emits exactly one finding per commitment per pass, at its current bracket", () => {
    // 30 days out is inside both the 60 and the 30 horizon. Emitting both
    // would produce two alerts about one commitment in one pass — the failure
    // the bracket rule exists to prevent.
    const { findings } = detectCommitmentExpiries([commitment()], OPTIONS, TODAY);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.horizonDays).toBe(30);
    expect(findings[0]!.daysRemaining).toBe(30);
  });

  it("walks the horizons one at a time as the term shortens", () => {
    const brackets = ["2026-10-01", "2026-09-09", "2026-08-17", "2026-08-12"].map((endDay) => {
      const { findings } = detectCommitmentExpiries([commitment({ endDay })], OPTIONS, TODAY);
      return findings[0]?.horizonDays;
    });
    // 52 days → 60; 30 days → 30; 7 days → 7; 2 days → still 7 (already
    // fired, and the events table absorbs the repeat).
    expect(brackets).toEqual([60, 30, 7, 7]);
  });

  it("says nothing while the term is beyond every horizon", () => {
    const { findings, skipped } = detectCommitmentExpiries(
      [commitment({ endDay: "2027-08-10" })],
      OPTIONS,
      TODAY,
    );
    expect(findings).toHaveLength(0);
    expect(skipped[0]!.reason).toBe("outside_horizons");
  });

  it("says nothing about a commitment the provider gave no end date for", () => {
    const { findings, skipped } = detectCommitmentExpiries(
      [commitment({ endDay: null })],
      OPTIONS,
      TODAY,
    );
    expect(findings).toHaveLength(0);
    expect(skipped[0]!.reason).toBe("no_end_date");
  });

  it("ignores a queued commitment — its own term has not started", () => {
    const { findings, skipped } = detectCommitmentExpiries(
      [commitment({ state: "queued" })],
      OPTIONS,
      TODAY,
    );
    expect(findings).toHaveLength(0);
    expect(skipped[0]!.reason).toBe("queued");
  });
});

describe("detectCommitmentExpiries — already expired", () => {
  it("raises one alert at horizon 0 for a commitment that lapsed unwarned", () => {
    const { findings } = detectCommitmentExpiries(
      [commitment({ endDay: "2026-08-06", state: "expired" })],
      OPTIONS,
      TODAY,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.horizonDays).toBe(0);
    expect(findings[0]!.daysRemaining).toBe(-4);
  });

  it("stays quiet about one that lapsed before the look-back", () => {
    const { findings, skipped } = detectCommitmentExpiries(
      [commitment({ endDay: "2025-01-01", state: "expired" })],
      OPTIONS,
      TODAY,
    );
    expect(findings).toHaveLength(0);
    expect(skipped[0]!.reason).toBe("expired_long_ago");
  });

  it("respects the org turning expired alerts off", () => {
    const { findings, skipped } = detectCommitmentExpiries(
      [commitment({ endDay: "2026-08-06", state: "expired" })],
      { ...OPTIONS, alertOnExpired: false },
      TODAY,
    );
    expect(findings).toHaveLength(0);
    expect(skipped[0]!.reason).toBe("expired_alerts_disabled");
  });
});

describe("detectCommitmentExpiries — renewal", () => {
  it("warns an auto-renewing commitment once, at the shortest horizon only", () => {
    // 30 days out. A non-renewing commitment fires the 30-day bracket here;
    // a renewing one waits for 7, because nothing lapses.
    const renewing = commitment({ autoRenew: true });
    expect(detectCommitmentExpiries([renewing], OPTIONS, TODAY).findings).toHaveLength(0);

    const { findings } = detectCommitmentExpiries(
      [commitment({ autoRenew: true, endDay: "2026-08-15" })],
      OPTIONS,
      TODAY,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.horizonDays).toBe(7);
    expect(findings[0]!.autoRenewing).toBe(true);
  });

  it("says nothing at all when a successor already covers the handover", () => {
    const incumbent = commitment({ commitmentId: "ri-old", endDay: "2026-09-09" });
    const successor = commitment({
      commitmentId: "ri-new",
      state: "queued",
      startDay: "2026-09-09",
      endDay: "2027-09-09",
    });
    const { findings, skipped } = detectCommitmentExpiries([incumbent, successor], OPTIONS, TODAY);
    expect(findings).toHaveLength(0);
    expect(skipped.find((s) => s.commitmentId === "ri-old")!.reason).toBe("succeeded");
  });

  it("does not treat a differently-described commitment as a successor", () => {
    const incumbent = commitment({ commitmentId: "ri-old" });
    const unrelated = commitment({
      commitmentId: "ri-other",
      description: "r6g.large · us-east-1",
      state: "queued",
      startDay: "2026-09-09",
      endDay: "2027-09-09",
    });
    const { findings } = detectCommitmentExpiries([incumbent, unrelated], OPTIONS, TODAY);
    expect(findings.map((f) => f.commitmentId)).toEqual(["ri-old"]);
  });
});

describe("detectCommitmentExpiries — what it costs", () => {
  it("states the monthly commitment and a floor on the on-demand exposure", () => {
    const { findings } = detectCommitmentExpiries([commitment()], OPTIONS, TODAY);
    const f = findings[0]!;
    // 1.5/hr × 24 × 30.4
    expect(f.monthlyCommitmentAmount).toBeCloseTo(1094.4, 1);
    // 1200 delivered over 30 measured days, restated to a month.
    expect(f.monthlyCoveredUsageAmount).toBeCloseTo(1216, 0);
  });

  it("states no exposure when nothing could be measured", () => {
    const { findings } = detectCommitmentExpiries(
      [commitment({ deliveredAmount: null, measuredDays: 0 })],
      OPTIONS,
      TODAY,
    );
    expect(findings[0]!.monthlyCoveredUsageAmount).toBeNull();
    // The commitment's own price is still known and still worth saying.
    expect(findings[0]!.monthlyCommitmentAmount).not.toBeNull();
  });

  it("states units and no money for a unit-denominated commitment", () => {
    const { findings } = detectCommitmentExpiries(
      [
        commitment({
          hourlyCommitmentAmount: null,
          currency: null,
          unitCommitments: [{ unit: "vCPU", amount: 2000 }],
          deliveredAmount: null,
          measuredDays: 0,
        }),
      ],
      OPTIONS,
      TODAY,
    );
    // A CUD expiring is still an expiry — it just states no money.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.monthlyCommitmentAmount).toBeNull();
    expect(findings[0]!.unitCommitments).toEqual([{ unit: "vCPU", amount: 2000 }]);
  });

  it("reports a genuine zero delivered as a rate of zero, not as unmeasured", () => {
    // Expiring completely unused is worth saying out loud, and it is a
    // different fact from "we could not measure it".
    const { findings } = detectCommitmentExpiries(
      [commitment({ deliveredAmount: 0, measuredDays: 30 })],
      OPTIONS,
      TODAY,
    );
    expect(findings[0]!.monthlyCoveredUsageAmount).toBe(0);
  });
});
