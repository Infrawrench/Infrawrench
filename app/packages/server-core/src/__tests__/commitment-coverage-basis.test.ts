/**
 * The two properties commitment coverage rests on, and one that the amortized
 * view rests on:
 *
 * 1. Coverage is measured on **amortized** money. Both AWS and Azure price
 *    commitment-covered usage at zero cash, so a cash ratio is 0% for every org
 *    that has ever bought a commitment — an answer-shaped non-answer.
 * 2. The covered/uncovered split is a **partition**. A row carrying both
 *    coverage signals must be counted once.
 * 3. The amortized money expression distinguishes an amortized amount of zero
 *    (a purchase, on its purchase day) from no amortized amount at all.
 */
import { describe, expect, it } from "vitest";

import {
  classifyCoverageRow,
  CONSUMPTION_CHARGE_TYPES,
  CONSUMPTION_SQL,
  COVERED_SQL,
  UNCOVERED_SQL,
} from "../clickhouse/commitment-readers";
import { amortizedAmountExpr } from "../clickhouse/cost-readers";
import { toCostDailyRows } from "../clickhouse/cost-writers";
import { computeCommitmentCoverage, type CoverageCell } from "../commitments/coverage";
import { COST_CHARGE_TYPES } from "@infrawrench/client-core";

// ─── A tiny evaluator for the money expression ──────────────────────────────

interface StoredRow {
  amount: number;
  amortized_amount: number;
  amortized_reported: number;
}

/**
 * Evaluate the *actual* expression `amortizedAmountExpr()` returns, rather than
 * a restatement of it, so this test fails if the SQL and the intent diverge.
 * Grammar is exactly the one the expression uses:
 * `if(<col> != 0 OR <col> != 0, <col>, <col>)`.
 */
function evaluateAmortized(expr: string, row: StoredRow): number {
  const match = /^if\((.+) != 0 OR (.+) != 0, (\w+), (\w+)\)$/.exec(expr);
  if (!match)
    throw new Error(`amortized expression is no longer the shape this test parses: ${expr}`);
  const col = (name: string): number => {
    const value = (row as unknown as Record<string, number>)[name];
    if (value === undefined) throw new Error(`unknown column ${name}`);
    return value;
  };
  return col(match[1]!) !== 0 || col(match[2]!) !== 0 ? col(match[3]!) : col(match[4]!);
}

// ─── 1. The basis ───────────────────────────────────────────────────────────

describe("commitment coverage is computed on amortized money", () => {
  it("uses the amortized expression on both sides of the ratio, never `amount`", () => {
    // Numerator and denominator must be the same kind of money — a mixed-basis
    // ratio is not a percentage of anything.
    const expr = amortizedAmountExpr();
    expect(expr).toContain("amortized_amount");
    expect(expr).toContain("amortized_reported");
    // Both `sumIf`s in the coverage query wrap this same expression.
    expect(`sumIf(${expr}, ${COVERED_SQL})`).toContain(expr);
    expect(`sumIf(${expr}, ${UNCOVERED_SQL})`).toContain(expr);
  });

  it("would report 0% forever on cash, which is why the basis is not optional", () => {
    // The AWS/Azure shape on the cash basis: covered usage priced at zero.
    const cashCells: CoverageCell[] = [
      {
        accountId: "acc-1",
        pluginId: "aws",
        service: "AmazonEC2",
        region: "us-east-1",
        currency: "USD",
        coveredAmount: 0,
        uncoveredAmount: 400,
      },
    ];
    const cash = computeCommitmentCoverage(cashCells, [
      { accountId: "acc-1", chargeTypesDeclared: true },
    ]);
    expect(cash.currencies[0]!.broadRatio).toBe(0);

    // The same estate, same rows, amortized: the covered hours are worth what
    // the commitment paid for them.
    const amortized = computeCommitmentCoverage(
      [{ ...cashCells[0]!, coveredAmount: 600 }],
      [{ accountId: "acc-1", chargeTypesDeclared: true }],
    );
    expect(amortized.currencies[0]!.broadRatio).toBeCloseTo(0.6);
  });
});

// ─── 2. The partition ───────────────────────────────────────────────────────

/**
 * Aggregate rows into one cell the way the coverage query's two `sumIf`s do —
 * by routing each row through {@link classifyCoverageRow}, the same rule the
 * SQL transliterates — and return the resulting broad ratio.
 *
 * `[chargeType, commitmentId, amortizedAmount]` per row.
 */
function coverageOf(...rowGroups: Array<Array<[string, string, number]>>): number | null {
  let coveredAmount = 0;
  let uncoveredAmount = 0;
  for (const row of rowGroups.flat()) {
    const [chargeType, commitmentId, amount] = row;
    const cls = classifyCoverageRow(chargeType, commitmentId);
    if (cls === "covered") coveredAmount += amount;
    else if (cls === "uncovered") uncoveredAmount += amount;
  }
  const report = computeCommitmentCoverage(
    [
      {
        accountId: "acc-1",
        pluginId: "p",
        service: "svc",
        region: "r",
        currency: "USD",
        coveredAmount,
        uncoveredAmount,
      },
    ],
    [{ accountId: "acc-1", chargeTypesDeclared: true }],
  );
  return report.currencies[0]?.broadRatio ?? null;
}

describe("the covered/uncovered split is a partition", () => {
  it("counts a row carrying the charge type but no commitment id as covered (the AWS shape)", () => {
    // Cost Explorer cannot group by SAVINGS_PLAN_ARN or RESERVATION_ID, so an
    // AWS row says it was covered and never says by what.
    expect(classifyCoverageRow("commitment_covered_usage", "")).toBe("covered");
    // …and that alone is enough to produce a real coverage figure.
    expect(coverageOf([["commitment_covered_usage", "", 600]], [["usage", "", 400]])).toBeCloseTo(
      0.6,
    );
  });

  it("counts a row carrying a commitment id but the plain charge type as covered (the Azure shape)", () => {
    expect(classifyCoverageRow("usage", "/providers/microsoft.capacity/…/res-1")).toBe("covered");
    expect(coverageOf([["usage", "res-1", 300]], [["usage", "", 100]])).toBeCloseTo(0.75);
  });

  it("counts a row carrying both signals exactly once", () => {
    // A provider that can report both produces this shape, and it must not be
    // added to the numerator twice — nor appear in the denominator as well.
    const both = classifyCoverageRow("commitment_covered_usage", "sp-arn-1");
    expect(both).toBe("covered");
    expect(both).not.toBe("uncovered");
    // 500 covered against 500 uncovered is 50%, not 66% (which is what
    // double-counting the both-signals row into a 1000 numerator would give).
    expect(
      coverageOf([["commitment_covered_usage", "sp-arn-1", 500]], [["usage", "", 500]]),
    ).toBeCloseTo(0.5);
  });

  it("assigns every charge type to exactly one class, with and without an id", () => {
    for (const chargeType of COST_CHARGE_TYPES) {
      for (const commitmentId of ["", "some-commitment"]) {
        const cls = classifyCoverageRow(chargeType, commitmentId);
        const consumption = CONSUMPTION_CHARGE_TYPES.includes(chargeType);
        expect(cls).toBe(
          consumption
            ? chargeType === "commitment_covered_usage" || commitmentId !== ""
              ? "covered"
              : "uncovered"
            : "not_consumption",
        );
      }
    }
    // A fee in the denominator double-counts the purchase against the usage it
    // bought; a negative discount line can push coverage past 100%.
    expect(classifyCoverageRow("commitment_fee", "sp-1")).toBe("not_consumption");
    expect(classifyCoverageRow("commitment_discount", "sp-1")).toBe("not_consumption");
    expect(classifyCoverageRow("credit", "")).toBe("not_consumption");
  });

  it("keeps the SQL fragments as the De Morgan pair of that rule", () => {
    // The queries cannot call `classifyCoverageRow`, so this pins the
    // transliteration: numerator OR, denominator the negation of each half.
    expect(COVERED_SQL).toBe("(charge_type = 'commitment_covered_usage' OR commitment_id != '')");
    expect(UNCOVERED_SQL).toBe(
      "(charge_type != 'commitment_covered_usage' AND commitment_id = '')",
    );
    // Covered usage stays inside the eligible universe: dropping it would
    // shrink the denominator by exactly the spend a commitment touches.
    expect(CONSUMPTION_SQL).toBe("charge_type IN ('usage', 'commitment_covered_usage')");
  });
});

// ─── 3. Absent vs zero on the amortized column ──────────────────────────────

describe("amortized money distinguishes a reported zero from no report", () => {
  const meta = { organizationId: "org-1", accountId: "acc-1", pluginId: "azure" };

  it("does not double-count a purchase whose honest amortized amount is zero", () => {
    // The scenario: a reservation bought for 1200 cash on one day, whose value
    // is redistributed across the covered usage it buys. The purchase's honest
    // amortized amount on its purchase day is 0.
    const [purchase, coveredUsage] = toCostDailyRows(meta, [
      {
        date: "2026-07-01",
        currency: "USD",
        amount: 1200,
        chargeType: "commitment_fee",
        amortizedAmount: 0,
      },
      {
        date: "2026-07-01",
        service: "Virtual Machines",
        currency: "USD",
        amount: 0,
        chargeType: "commitment_covered_usage",
        amortizedAmount: 40,
      },
    ]);

    const expr = amortizedAmountExpr();
    // The purchase contributes nothing to an amortized total…
    expect(evaluateAmortized(expr, purchase!)).toBe(0);
    // …and the amortized slice contributes its own value.
    expect(evaluateAmortized(expr, coveredUsage!)).toBe(40);
    // Together: 40, not 1240. Before `amortized_reported` existed the purchase
    // fell back to its cash amount and the amortized view showed the purchase
    // at full price alongside every slice of it.
    expect(evaluateAmortized(expr, purchase!) + evaluateAmortized(expr, coveredUsage!)).toBe(40);
  });

  it("still falls back to cash for a provider that reports no amortized amount", () => {
    const [row] = toCostDailyRows(meta, [
      { date: "2026-07-01", service: "Storage", currency: "USD", amount: 17 },
    ]);
    expect(row!.amortized_reported).toBe(0);
    // Without the fallback, a mixed estate would see its non-amortizing
    // providers vanish the moment the amortized view was selected.
    expect(evaluateAmortized(amortizedAmountExpr(), row!)).toBe(17);
  });

  it("reads pre-existing rows exactly as it did before the column was added", () => {
    // Rows written before `amortized_reported` existed default it to 0. Both
    // legacy branches must behave identically to the old
    // `if(amortized_amount != 0, amortized_amount, amount)`.
    const expr = amortizedAmountExpr();
    const legacyAmortizing = { amount: 100, amortized_amount: 8, amortized_reported: 0 };
    const legacyNotAmortizing = { amount: 100, amortized_amount: 0, amortized_reported: 0 };
    expect(evaluateAmortized(expr, legacyAmortizing)).toBe(8);
    expect(evaluateAmortized(expr, legacyNotAmortizing)).toBe(100);
  });

  it("marks a reported amount as reported whatever its value", () => {
    const rows = toCostDailyRows(meta, [
      { date: "2026-07-01", currency: "USD", amount: 5, amortizedAmount: 0 },
      { date: "2026-07-01", service: "a", currency: "USD", amount: 5, amortizedAmount: 5 },
      { date: "2026-07-01", service: "b", currency: "USD", amount: 5 },
    ]);
    expect(rows.map((r) => r.amortized_reported)).toEqual([1, 1, 0]);
  });
});

// ─── 4. A ratio, or nothing ─────────────────────────────────────────────────

/**
 * Both sums are net of refunds, credits and corrections, so a window's spend
 * can land at zero or below. Coverage is read as a purchasing signal, and a
 * wrong number there is worse than a missing one — every one of these has to
 * report unavailable rather than arithmetic.
 */
describe("coverage reports unavailable rather than a meaningless ratio", () => {
  function report(coveredAmount: number, uncoveredAmount: number) {
    return computeCommitmentCoverage(
      [
        {
          accountId: "acc-1",
          pluginId: "p",
          service: "svc",
          region: "r",
          currency: "USD",
          coveredAmount,
          uncoveredAmount,
        },
      ],
      [{ accountId: "acc-1", chargeTypesDeclared: true }],
    ).currencies[0]!;
  }

  it("declines a denominator that refunds have driven negative", () => {
    // A returned reservation credited back against a quiet month.
    const r = report(100, -400);
    expect(r.broadRatio).toBeNull();
    expect(r.narrowRatio).toBeNull();
    // The underlying sums are still reported — the report says what it saw,
    // it just declines to divide by it.
    expect(r.coveredAmount).toBe(100);
    expect(r.uncoveredAmount).toBe(-400);
  });

  it("declines a denominator so near zero that the quotient is nonsense", () => {
    // 50 ÷ 0.004 is 1,250,000%. Arithmetically correct, and it would render as
    // an answer next to a real one.
    expect(report(50, -49.996).broadRatio).toBeNull();
    // One unit of the currency is the floor: far under any real window's
    // consumption, far over the float residue of a cancelled-out month.
    expect(report(0.5, 0.4).broadRatio).toBeNull();
  });

  it("declines a negative numerator instead of reporting negative coverage", () => {
    // Refunding a commitment for more than it delivered in the window is not
    // "−12% covered"; it is a window this measure does not describe.
    expect(report(-30, 500).broadRatio).toBeNull();
  });

  it("declines a ratio above 100%, which only an uncovered side below zero produces", () => {
    expect(report(100, -50).broadRatio).toBeNull();
  });

  it("still answers for an ordinary window, and for a fully covered one", () => {
    expect(report(600, 400).broadRatio).toBeCloseTo(0.6);
    // Float residue on a fully covered window must round to 1, not fall off
    // the >1 guard.
    const full = report(1000, -1e-12);
    expect(full.broadRatio).toBe(1);
  });

  it("declines a window with no spend at all, as it always has", () => {
    expect(report(0, 0).broadRatio).toBeNull();
  });
});
