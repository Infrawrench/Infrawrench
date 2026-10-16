import { describe, expect, it } from "vitest";

import {
  buildCommitmentReport,
  commitmentDaysUntilEnd,
  commitmentReportBucketOf,
  commitmentReportBuckets,
  commitmentReportCsvFileName,
  commitmentReportToCsv,
  computeCommitmentReportMetrics,
  emptyCommitmentReportTotals,
  isCommitmentExpiringSoon,
  normalizeCommitmentReportConfig,
  normalizeCommitmentReportInput,
  COMMITMENT_REPORT_ON_DEMAND_KEY,
  COMMITMENT_REPORT_UNATTRIBUTED_KEY,
  DEFAULT_COMMITMENT_REPORT_CONFIG,
  type CommitmentReportCell,
  type CommitmentReportTotals,
} from "../index";

function totals(partial: Partial<CommitmentReportTotals>): CommitmentReportTotals {
  const t = { ...emptyCommitmentReportTotals(), ...partial };
  // Without a commitment filter, everything covered was covered by a selected commitment.
  if (partial.coveredAll === undefined) t.coveredAll = t.covered;
  return t;
}

function cell(
  bucket: string,
  groupKey: string,
  partial: Partial<CommitmentReportTotals>,
  currency = "USD",
): CommitmentReportCell {
  return { bucket, groupKey, currency, ...totals(partial) };
}

describe("computeCommitmentReportMetrics", () => {
  it("computes every metric from the documented formulas", () => {
    // 80 covered (on-demand equivalent 120, all measured), 20 unused fee,
    // 100 uncovered of which 50 in cells a commitment ever covered.
    const m = computeCommitmentReportMetrics(
      totals({
        covered: 80,
        unused: 20,
        uncovered: 100,
        uncoveredEligible: 50,
        coveredOnDemand: 120,
        coveredMeasured: 80,
      }),
    );
    expect(m.usedCommitmentCost).toBe(80);
    expect(m.unusedCommitmentCost).toBe(20);
    expect(m.commitmentCost).toBe(100);
    expect(m.onDemandRemainder).toBe(100);
    expect(m.coverage).toBeCloseTo(80 / 180, 12);
    expect(m.eligibleCoverage).toBeCloseTo(80 / 130, 12);
    expect(m.utilization).toBeCloseTo(0.8, 12);
    // Gross saving 40, minus 20 wasted.
    expect(m.netSavings).toBeCloseTo(20, 12);
    expect(m.onDemandEquivalent).toBeCloseTo(120, 12);
    // 20 saved on 220 of on-demand-equivalent spend.
    expect(m.effectiveSavingsRate).toBeCloseTo(20 / 220, 12);
    expect(m.savingsMeasuredShare).toBe(1);
  });

  it("returns null ratios, never 0, when there is nothing to divide by", () => {
    const m = computeCommitmentReportMetrics(emptyCommitmentReportTotals());
    expect(m.coverage).toBeNull();
    expect(m.eligibleCoverage).toBeNull();
    expect(m.utilization).toBeNull();
    expect(m.effectiveSavingsRate).toBeNull();
    expect(m.savingsMeasuredShare).toBeNull();
    // No commitment activity at all: nothing saved, nothing lost.
    expect(m.netSavings).toBe(0);
  });

  it("reports savings as unknown when no covered usage has an on-demand equivalent", () => {
    const m = computeCommitmentReportMetrics(totals({ covered: 50, unused: 10, uncovered: 50 }));
    expect(m.netSavings).toBeNull();
    expect(m.effectiveSavingsRate).toBeNull();
    expect(m.savingsMeasuredShare).toBe(0);
    // The ratios that need no on-demand figure still compute.
    expect(m.coverage).toBeCloseTo(0.5, 12);
    expect(m.utilization).toBeCloseTo(50 / 60, 12);
  });

  it("counts unmeasured covered usage as saving nothing", () => {
    // 100 covered, 60 of it measured at an on-demand cost of 90.
    const m = computeCommitmentReportMetrics(
      totals({ covered: 100, coveredOnDemand: 90, coveredMeasured: 60 }),
    );
    expect(m.netSavings).toBeCloseTo(30, 12);
    expect(m.onDemandEquivalent).toBeCloseTo(130, 12);
    expect(m.savingsMeasuredShare).toBeCloseTo(0.6, 12);
  });

  it("reports a wholly idle commitment as a loss and 0% utilized", () => {
    const m = computeCommitmentReportMetrics(totals({ unused: 30, uncovered: 70 }));
    expect(m.utilization).toBe(0);
    expect(m.netSavings).toBe(-30);
    expect(m.effectiveSavingsRate).toBeCloseTo(-30 / 70, 12);
    expect(m.coverage).toBe(0);
  });

  it("keeps other commitments' coverage in the denominator under a commitment filter", () => {
    // The selected plan covered 30; all commitments together 60; 40 on demand.
    const m = computeCommitmentReportMetrics(
      totals({ covered: 30, coveredAll: 60, uncovered: 40 }),
    );
    expect(m.coverage).toBeCloseTo(0.3, 12);
  });

  it("uses a supplied bucket base for coverage", () => {
    const m = computeCommitmentReportMetrics(totals({ covered: 25 }), {
      usage: 100,
      eligibleUsage: 50,
    });
    expect(m.coverage).toBe(0.25);
    expect(m.eligibleCoverage).toBe(0.5);
  });
});

describe("buckets", () => {
  it("starts weeks on Monday and quarters on their first month", () => {
    expect(commitmentReportBucketOf("2026-07-05", "weekly")).toBe("2026-06-29");
    expect(commitmentReportBucketOf("2026-06-29", "weekly")).toBe("2026-06-29");
    expect(commitmentReportBucketOf("2026-08-17", "monthly")).toBe("2026-08-01");
    expect(commitmentReportBucketOf("2026-08-17", "quarterly")).toBe("2026-07-01");
    expect(commitmentReportBucketOf("2026-08-17", "daily")).toBe("2026-08-17");
  });

  it("lists every bucket, the partial first and last included", () => {
    expect(commitmentReportBuckets("2026-01-30", "2026-04-02", "monthly")).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
    ]);
    expect(commitmentReportBuckets("2026-07-01", "2026-07-03", "daily")).toHaveLength(3);
    expect(commitmentReportBuckets("2026-07-01", "2026-07-14", "weekly")).toEqual([
      "2026-06-29",
      "2026-07-06",
      "2026-07-13",
    ]);
  });
});

describe("buildCommitmentReport", () => {
  const ctx = {
    from: "2026-07-01",
    to: "2026-07-03",
    granularity: "daily" as const,
    groupBy: "none" as const,
  };

  it("fills every bucket, with null ratios on days nothing was collected", () => {
    const result = buildCommitmentReport(
      [cell("2026-07-01", "", { covered: 10, uncovered: 10 })],
      ctx,
    );
    expect(result.buckets).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    const points = result.overall[0]!.points;
    expect(points.map((p) => p.metrics.coverage)).toEqual([0.5, null, null]);
    expect(result.overall[0]!.total.metrics.coverage).toBe(0.5);
  });

  it("keeps currencies apart and never sums across them", () => {
    const result = buildCommitmentReport(
      [
        cell("2026-07-01", "", { covered: 10, uncovered: 10 }, "USD"),
        cell("2026-07-01", "", { covered: 0, uncovered: 10 }, "EUR"),
      ],
      ctx,
    );
    expect(result.overall.map((s) => [s.currency, s.total.metrics.coverage])).toEqual([
      ["EUR", 0],
      ["USD", 0.5],
    ]);
  });

  it("rolls days into the bucket that holds them", () => {
    const result = buildCommitmentReport(
      [cell("2026-07-01", "", { covered: 10 }), cell("2026-07-02", "", { covered: 5, unused: 5 })],
      { ...ctx, granularity: "monthly" },
    );
    expect(result.buckets).toEqual(["2026-07-01"]);
    expect(result.overall[0]!.points[0]!.metrics.utilization).toBe(0.75);
  });

  it("makes a commitment grouping's coverages add up to the bucket's", () => {
    const result = buildCommitmentReport(
      [
        cell("2026-07-01", "sp-1", { covered: 30 }),
        cell("2026-07-01", "ri-1", { covered: 20, unused: 5 }),
        cell("2026-07-01", COMMITMENT_REPORT_ON_DEMAND_KEY, { uncovered: 50 }),
      ],
      { ...ctx, to: "2026-07-01", groupBy: "commitment" },
    );
    const byKey = new Map(result.series.map((s) => [s.groupKey, s]));
    expect(byKey.get("sp-1")!.total.metrics.coverage).toBeCloseTo(0.3, 12);
    expect(byKey.get("ri-1")!.total.metrics.coverage).toBeCloseTo(0.2, 12);
    expect(byKey.get(COMMITMENT_REPORT_ON_DEMAND_KEY)!.total.metrics.coverage).toBe(0);
    expect(result.overall[0]!.total.metrics.coverage).toBeCloseTo(0.5, 12);
    // Utilization stays per holding.
    expect(byKey.get("ri-1")!.total.metrics.utilization).toBeCloseTo(0.8, 12);
    // Largest commitment cost first.
    expect(result.series[0]!.groupKey).toBe("sp-1");
  });

  it("drops a commitment group that only fed the denominator", () => {
    const result = buildCommitmentReport(
      [
        cell("2026-07-01", "sp-1", { covered: 30 }),
        // Covered by an unselected commitment: in the denominator only.
        cell("2026-07-01", "sp-2", { covered: 0, coveredAll: 20 }),
        cell("2026-07-01", COMMITMENT_REPORT_ON_DEMAND_KEY, { uncovered: 50 }),
      ],
      { ...ctx, to: "2026-07-01", groupBy: "commitment" },
    );
    expect(result.series.map((s) => s.groupKey).sort()).toEqual(
      [COMMITMENT_REPORT_ON_DEMAND_KEY, "sp-1"].sort(),
    );
    expect(result.series.find((s) => s.groupKey === "sp-1")!.total.metrics.coverage).toBeCloseTo(
      0.3,
      12,
    );
  });

  it("names unattributed commitment usage and partial savings in its notices", () => {
    const result = buildCommitmentReport(
      [
        cell("2026-07-01", COMMITMENT_REPORT_UNATTRIBUTED_KEY, {
          covered: 30,
          coveredOnDemand: 15,
          coveredMeasured: 10,
        }),
      ],
      { ...ctx, groupBy: "commitment_type", notices: ["unused_lumped_monthly"] },
    );
    expect(result.notices).toEqual([
      "unused_lumped_monthly",
      "unattributed_commitment_usage",
      "partial_savings_measurement",
    ]);
  });

  it("uses server labels and falls back to the key", () => {
    const result = buildCommitmentReport(
      [cell("2026-07-01", "acc-1", { covered: 1 }), cell("2026-07-01", "acc-2", { covered: 2 })],
      { ...ctx, groupBy: "account", labels: new Map([["acc-1", "Production"]]) },
    );
    expect(result.series.map((s) => s.label).sort()).toEqual(["Production", "acc-2"]);
  });
});

describe("commitmentReportToCsv", () => {
  it("writes ratios as fractions, gaps as empty cells, and a total row", () => {
    const result = buildCommitmentReport([cell("2026-07-01", "", { covered: 10, uncovered: 30 })], {
      from: "2026-07-01",
      to: "2026-07-02",
      granularity: "daily",
      groupBy: "none",
    });
    const lines = commitmentReportToCsv(result).trim().split("\r\n");
    expect(lines[0]).toContain('"coverage"');
    expect(lines).toHaveLength(4);
    expect(lines[1]!.startsWith('"2026-07-01","","USD",0.25,')).toBe(true);
    // Day two: no data, so coverage is blank rather than 0.
    expect(lines[2]!.startsWith('"2026-07-02","","USD",,')).toBe(true);
    expect(lines[3]!.startsWith('"total"')).toBe(true);
  });

  it("guards labels that look like formulas and keeps negative numbers numeric", () => {
    const result = buildCommitmentReport(
      [cell("2026-07-01", "x", { unused: 5, coveredMeasured: 0 })],
      {
        from: "2026-07-01",
        to: "2026-07-01",
        granularity: "daily",
        groupBy: "account",
        labels: new Map([["x", "=HYPERLINK(1)"]]),
      },
    );
    const csv = commitmentReportToCsv(result);
    expect(csv).toContain('"\t=HYPERLINK(1)"');
    expect(csv).toContain(",-5,");
  });

  it("slugs a file name", () => {
    expect(commitmentReportCsvFileName("Q3 / Savings plans!", "2026-07-01", "2026-09-30")).toBe(
      "q3-savings-plans-2026-07-01-to-2026-09-30.csv",
    );
  });
});

describe("normalizeCommitmentReportConfig", () => {
  it("accepts the default and fills omitted optional fields", () => {
    expect(normalizeCommitmentReportConfig(DEFAULT_COMMITMENT_REPORT_CONFIG)).toEqual({
      ok: true,
      value: DEFAULT_COMMITMENT_REPORT_CONFIG,
    });
    const parsed = normalizeCommitmentReportConfig({
      version: 1,
      dateRange: { kind: "relative", preset: "30d" },
      granularity: "daily",
    });
    expect(parsed.ok && parsed.value.groupBy).toBe("none");
    expect(parsed.ok && parsed.value.metric).toBe("coverage");
  });

  it("refuses hourly with the reason", () => {
    const parsed = normalizeCommitmentReportConfig({
      ...DEFAULT_COMMITMENT_REPORT_CONFIG,
      granularity: "hourly",
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/one row per day/);
  });

  it("refuses unknown fields and filters rather than dropping them", () => {
    expect(
      normalizeCommitmentReportConfig({ ...DEFAULT_COMMITMENT_REPORT_CONFIG, binning: "daily" }).ok,
    ).toBe(false);
    expect(
      normalizeCommitmentReportConfig({
        ...DEFAULT_COMMITMENT_REPORT_CONFIG,
        filters: { provider: ["aws"] },
      }).ok,
    ).toBe(false);
    expect(
      normalizeCommitmentReportConfig({
        ...DEFAULT_COMMITMENT_REPORT_CONFIG,
        filters: { commitmentTypes: ["spot"] },
      }).ok,
    ).toBe(false);
  });

  it("dedupes filter values and drops empty lists", () => {
    const parsed = normalizeCommitmentReportConfig({
      ...DEFAULT_COMMITMENT_REPORT_CONFIG,
      filters: { providers: ["aws", "aws"], regions: [] },
    });
    expect(parsed.ok && parsed.value.filters).toEqual({ providers: ["aws"] });
  });

  it("checks absolute ranges against the limits", () => {
    const base = { ...DEFAULT_COMMITMENT_REPORT_CONFIG, granularity: "daily" as const };
    expect(
      normalizeCommitmentReportConfig({
        ...base,
        dateRange: { kind: "absolute", from: "2025-01-01", to: "2026-06-30" },
      }).ok,
    ).toBe(false);
    expect(
      normalizeCommitmentReportConfig({
        ...base,
        granularity: "monthly",
        dateRange: { kind: "absolute", from: "2025-01-01", to: "2026-06-30" },
      }).ok,
    ).toBe(true);
    expect(
      normalizeCommitmentReportConfig({
        ...base,
        dateRange: { kind: "absolute", from: "2026-07-02", to: "2026-07-01" },
      }).ok,
    ).toBe(false);
    expect(
      normalizeCommitmentReportConfig({
        ...base,
        dateRange: { kind: "absolute", from: "2026-02-30", to: "2026-03-01" },
      }).ok,
    ).toBe(false);
  });
});

describe("normalizeCommitmentReportInput", () => {
  it("trims the name and requires one", () => {
    const parsed = normalizeCommitmentReportInput({
      name: "  Coverage by account ",
      config: DEFAULT_COMMITMENT_REPORT_CONFIG,
    });
    expect(parsed.ok && parsed.value).toEqual({
      name: "Coverage by account",
      description: null,
      config: DEFAULT_COMMITMENT_REPORT_CONFIG,
      folderId: null,
    });
    expect(
      normalizeCommitmentReportInput({ name: " ", config: DEFAULT_COMMITMENT_REPORT_CONFIG }).ok,
    ).toBe(false);
  });
});

describe("expiring soon", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  it("flags active holdings ending within sixty days", () => {
    expect(
      isCommitmentExpiringSoon({ state: "active", endDate: "2026-08-01T00:00:00Z" }, now),
    ).toBe(true);
    expect(
      isCommitmentExpiringSoon({ state: "active", endDate: "2026-12-01T00:00:00Z" }, now),
    ).toBe(false);
    expect(
      isCommitmentExpiringSoon({ state: "expired", endDate: "2026-07-02T00:00:00Z" }, now),
    ).toBe(false);
    expect(isCommitmentExpiringSoon({ state: "active", endDate: null }, now)).toBe(false);
    expect(commitmentDaysUntilEnd({ endDate: "2026-07-11T12:00:00Z" }, now)).toBe(10);
  });
});
