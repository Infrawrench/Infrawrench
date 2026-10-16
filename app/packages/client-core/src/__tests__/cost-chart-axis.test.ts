import { describe, expect, it } from "vitest";
import {
  COST_X_SEGMENT_SEPARATOR,
  applyCostDrillPath,
  applyCostDrillStep,
  costCategoryChart,
  costComparisonDelta,
  costDrillChoices,
  costDrillNeedsChoice,
  costDrillReportName,
  costDrillTarget,
  formatCostChangePct,
  nextCostDrillDimension,
  pivotCostGroupsToDimensionAxis,
  resolveCostDrillStep,
  splitCostXSegmentKey,
  type CostDrillStep,
} from "../cost-chart-axis";
import {
  DEFAULT_COST_GRAPH_CONFIG,
  costDisplayProblem,
  costQueryForConfig,
  type CostGraphConfig,
  type CostQueryResponse,
} from "../costs";
import { applyCostReportRunOverrides } from "../cost-reports";

const SEP = COST_X_SEGMENT_SEPARATOR;
const base: CostGraphConfig = { ...DEFAULT_COST_GRAPH_CONFIG };

describe("pivotCostGroupsToDimensionAxis", () => {
  const groups = [
    {
      key: "ec2",
      currency: "USD",
      points: [
        { bucket: "2026-07-01", amount: 10 },
        { bucket: "2026-07-02", amount: 5 },
      ],
    },
    { key: "s3", currency: "USD", points: [{ bucket: "2026-07-01", amount: 3 }] },
    { key: "rds", currency: "USD", points: [{ bucket: "2026-07-02", amount: 7 }] },
    { key: "lambda", currency: "USD", points: [{ bucket: "2026-07-02", amount: 1 }] },
  ];

  it("ranks values by spend and folds the tail into Other", () => {
    const out = pivotCostGroupsToDimensionAxis(groups, { segment: "none", topN: 2 });
    expect(out.categories).toEqual(["ec2", "rds", "__other__"]);
    expect(out.series).toEqual([
      {
        key: "",
        currency: "USD",
        points: [
          { bucket: "ec2", amount: 15 },
          { bucket: "rds", amount: 7 },
          { bucket: "__other__", amount: 4 },
        ],
      },
    ]);
  });

  it("adds no Other when nothing folds", () => {
    const out = pivotCostGroupsToDimensionAxis(groups, { segment: "none", topN: 10 });
    expect(out.categories).toEqual(["ec2", "rds", "s3", "lambda"]);
  });

  it("segments each value by date bin, chronologically", () => {
    const out = pivotCostGroupsToDimensionAxis(groups, { segment: "date", topN: 2 });
    expect(out.series.map((s) => s.key)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(out.series[0]!.points).toEqual([
      { bucket: "ec2", amount: 10 },
      { bucket: "__other__", amount: 3 },
    ]);
    expect(out.series[1]!.points).toEqual([
      { bucket: "ec2", amount: 5 },
      { bucket: "rds", amount: 7 },
      { bucket: "__other__", amount: 1 },
    ]);
  });

  it("splits a two-dimension key and folds segments to the top N too", () => {
    const out = pivotCostGroupsToDimensionAxis(
      [
        {
          key: `aws${SEP}us-east-1`,
          currency: "USD",
          points: [{ bucket: "2026-07-01", amount: 8 }],
        },
        {
          key: `aws${SEP}eu-west-1`,
          currency: "USD",
          points: [{ bucket: "2026-07-01", amount: 4 }],
        },
        {
          key: `gcp${SEP}us-east-1`,
          currency: "USD",
          points: [{ bucket: "2026-07-01", amount: 6 }],
        },
        { key: `gcp${SEP}asia-1`, currency: "USD", points: [{ bucket: "2026-07-01", amount: 1 }] },
      ],
      { segment: "dimension", topN: 2 },
    );
    expect(out.categories).toEqual(["aws", "gcp"]);
    expect(out.series.map((s) => s.key)).toEqual(["us-east-1", "eu-west-1", "__other__"]);
    expect(out.series[0]!.points).toEqual([
      { bucket: "aws", amount: 8 },
      { bucket: "gcp", amount: 6 },
    ]);
    expect(out.series[2]!.points).toEqual([{ bucket: "gcp", amount: 1 }]);
  });

  it("folds a previous period onto the current period's values", () => {
    const out = pivotCostGroupsToDimensionAxis(groups, {
      segment: "none",
      topN: 2,
      keepCategories: ["s3", "lambda", "__other__"],
    });
    expect(out.categories).toEqual(["s3", "lambda", "__other__"]);
    expect(out.series[0]!.points).toEqual([
      { bucket: "s3", amount: 3 },
      { bucket: "lambda", amount: 1 },
      { bucket: "__other__", amount: 22 },
    ]);
  });

  it("keeps currencies apart", () => {
    const out = pivotCostGroupsToDimensionAxis(
      [
        { key: "a", currency: "USD", points: [{ bucket: "2026-07-01", amount: 1 }] },
        { key: "a", currency: "EUR", points: [{ bucket: "2026-07-01", amount: 2 }] },
      ],
      { segment: "none", topN: 5 },
    );
    expect(out.series.map((s) => s.currency)).toEqual(["EUR", "USD"]);
  });

  it("splits keys on the first separator only", () => {
    expect(splitCostXSegmentKey(`a${SEP}b${SEP}c`)).toEqual({ x: "a", segment: `b${SEP}c` });
    expect(splitCostXSegmentKey("solo")).toEqual({ x: "solo", segment: "" });
  });
});

describe("costCategoryChart", () => {
  it("lays a date axis out by bucket and pairs the previous period by position", () => {
    const response: CostQueryResponse = {
      series: [
        {
          key: "aws",
          label: "AWS",
          currency: "USD",
          points: [
            { bucket: "2026-07-01", amount: 4 },
            { bucket: "2026-07-02", amount: 6 },
          ],
        },
        {
          key: "gcp",
          label: "GCP",
          currency: "USD",
          points: [{ bucket: "2026-07-02", amount: 1 }],
        },
      ],
      comparison: [
        {
          key: "aws",
          label: "AWS",
          currency: "USD",
          points: [
            { bucket: "2026-06-01", amount: 2 },
            { bucket: "2026-06-02", amount: 3 },
          ],
        },
      ],
      currencies: ["USD"],
      totals: { USD: 11 },
    };
    const chart = costCategoryChart(response, "daily");
    expect(chart.axis).toBe("date");
    expect(chart.categories.map((c) => c.key)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(chart.series[1]!.values).toEqual([null, 1]);
    expect(chart.totals).toEqual([4, 7]);
    expect(chart.previous).toEqual([2, 3]);
  });

  it("lays a dimension axis out in the server's order and pairs the previous period by value", () => {
    const response: CostQueryResponse = {
      series: [
        {
          key: "2026-07-01",
          label: "2026-07-01",
          currency: "USD",
          points: [{ bucket: "ec2", amount: 10 }],
        },
        {
          key: "2026-07-02",
          label: "2026-07-02",
          currency: "USD",
          points: [
            { bucket: "ec2", amount: 5 },
            { bucket: "__other__", amount: 2 },
          ],
        },
      ],
      comparison: [
        {
          key: "",
          label: "",
          currency: "USD",
          points: [
            { bucket: "__other__", amount: 1 },
            { bucket: "ec2", amount: 20 },
          ],
        },
      ],
      currencies: ["USD"],
      totals: { USD: 17 },
      xAxis: {
        dimension: "service",
        segment: "date",
        values: [
          { key: "ec2", label: "EC2" },
          { key: "s3", label: "S3" },
          { key: "__other__", label: "Other" },
        ],
      },
    };
    const chart = costCategoryChart(response, "monthly");
    expect(chart.axis).toBe("dimension");
    expect(chart.categories).toEqual([
      { key: "ec2", label: "EC2", isOther: false },
      { key: "s3", label: "S3", isOther: false },
      { key: "__other__", label: "Other", isOther: true },
    ]);
    // Date segments are labelled as bins, not raw dates.
    expect(chart.series[0]!.label).toBe("Jul 2026");
    expect(chart.totals).toEqual([15, 0, 2]);
    expect(chart.previous).toEqual([20, null, 1]);
  });

  it("has no previous row without a comparison", () => {
    const chart = costCategoryChart({ series: [], currencies: [], totals: {} }, "daily");
    expect(chart.previous).toBeNull();
  });
});

describe("costComparisonDelta", () => {
  it("computes the change and percentage", () => {
    expect(costComparisonDelta(120, 100)).toEqual({ change: 20, changePct: 20 });
    expect(costComparisonDelta(50, 100)).toEqual({ change: -50, changePct: -50 });
  });
  it("has no percentage of zero and no delta without a previous figure", () => {
    expect(costComparisonDelta(5, 0)).toEqual({ change: 5, changePct: null });
    expect(costComparisonDelta(5, null)).toBeNull();
    expect(costComparisonDelta(5, undefined)).toBeNull();
  });
  it("formats signs", () => {
    expect(formatCostChangePct(12.345)).toBe("+12.3%");
    expect(formatCostChangePct(-4)).toBe("−4.0%");
    expect(formatCostChangePct(0)).toBe("0.0%");
    expect(formatCostChangePct(null)).toBe("–");
  });
});

describe("drill-down", () => {
  it("drills on the group-by on a date axis and on the X axis otherwise", () => {
    expect(costDrillTarget({ ...base, groupBy: "provider" })).toEqual({ dimension: "provider" });
    expect(costDrillTarget({ ...base, groupBy: "none" })).toBeNull();
    expect(costDrillTarget({ ...base, groupBy: "service", measure: "count" })).toBeNull();
    expect(
      costDrillTarget({ ...base, groupBy: "region", xAxis: "tag", xAxisTagKey: "team" }),
    ).toEqual({ dimension: "tag", tagKey: "team" });
    expect(costDrillTarget({ ...base, unitCostMetricId: "m1" })).toBeNull();
  });

  it("follows provider → service → region → resource", () => {
    expect(nextCostDrillDimension("provider")).toBe("service");
    expect(nextCostDrillDimension("service")).toBe("region");
    expect(nextCostDrillDimension("region")).toBe("resource");
    expect(nextCostDrillDimension("resource")).toBeNull();
    expect(nextCostDrillDimension("tag")).toBeNull();
    expect(costDrillNeedsChoice("tag")).toBe(true);
    expect(costDrillNeedsChoice("virtual_tag")).toBe(true);
    expect(costDrillNeedsChoice("service")).toBe(false);
  });

  it("offers unkeyed dimensions other than the current one as choices", () => {
    const choices = costDrillChoices("service");
    expect(choices).not.toContain("service");
    expect(choices).not.toContain("tag");
    expect(choices).toContain("region");
  });

  it("resolves a click to a step, refusing Other and leaves without a choice", () => {
    const cfg: CostGraphConfig = { ...base, groupBy: "provider" };
    expect(resolveCostDrillStep(cfg, "aws", "Amazon Web Services")).toEqual({
      from: { dimension: "provider" },
      value: "aws",
      label: "Amazon Web Services",
      to: { dimension: "service" },
    });
    expect(resolveCostDrillStep(cfg, "__other__", "Other")).toBeNull();
    expect(resolveCostDrillStep({ ...base, groupBy: "resource" }, "i-1", "i-1")).toBeNull();
    expect(
      resolveCostDrillStep({ ...base, groupBy: "tag", groupByTagKey: "team" }, "web", "web", {
        dimension: "service",
      }),
    ).toMatchObject({ from: { dimension: "tag", tagKey: "team" }, to: { dimension: "service" } });
  });

  it("adds the value as a filter and regroups, replacing a broader in filter", () => {
    const cfg: CostGraphConfig = {
      ...base,
      groupBy: "provider",
      filters: [
        { dimension: "provider", op: "in", values: ["aws", "gcp"] },
        { dimension: "region", op: "not_in", values: ["cn-north-1"] },
      ],
    };
    const step: CostDrillStep = {
      from: { dimension: "provider" },
      value: "aws",
      label: "AWS",
      to: { dimension: "service" },
    };
    const next = applyCostDrillStep(cfg, step);
    expect(next.groupBy).toBe("service");
    expect(next.filters).toEqual([
      { dimension: "region", op: "not_in", values: ["cn-north-1"] },
      { dimension: "provider", op: "in", values: ["aws"] },
    ]);
    // The saved config is untouched.
    expect(cfg.groupBy).toBe("provider");
  });

  it("moves the X axis on a dimension axis and drops a segment that would equal it", () => {
    const cfg: CostGraphConfig = { ...base, xAxis: "provider", groupBy: "service" };
    const next = applyCostDrillStep(cfg, {
      from: { dimension: "provider" },
      value: "aws",
      label: "AWS",
      to: { dimension: "service" },
    });
    expect(next.xAxis).toBe("service");
    expect(next.groupBy).toBe("none");
    expect(costDisplayProblem(next)).toBeNull();
  });

  it("applies a whole path in order", () => {
    const steps: CostDrillStep[] = [
      { from: { dimension: "provider" }, value: "aws", label: "AWS", to: { dimension: "service" } },
      { from: { dimension: "service" }, value: "ec2", label: "EC2", to: { dimension: "region" } },
    ];
    const out = applyCostDrillPath({ ...base, groupBy: "provider" }, steps);
    expect(out.groupBy).toBe("region");
    expect(out.filters.map((f) => f.values[0])).toEqual(["aws", "ec2"]);
    expect(applyCostDrillPath(base, [])).toBe(base);
  });

  it("names a saved drill after the path, keeping the deepest value", () => {
    const steps: CostDrillStep[] = [
      { from: { dimension: "provider" }, value: "aws", label: "AWS", to: { dimension: "service" } },
      { from: { dimension: "service" }, value: "ec2", label: "EC2", to: { dimension: "region" } },
    ];
    expect(costDrillReportName("Spend", steps)).toBe("Spend › AWS › EC2");
    expect(costDrillReportName("Spend", [])).toBe("Spend");
    expect(costDrillReportName("Spend", steps, 15)).toBe("Spend › … › EC2");
  });
});

describe("run overrides with an X axis", () => {
  it("puts a dimension on X for one run, dropping what needs dates", () => {
    const out = applyCostReportRunOverrides(
      { ...base, groupBy: "service", showForecast: true, scenarioModelId: "s" },
      { xAxis: "service" },
    );
    expect(out).toMatchObject({ xAxis: "service", groupBy: "none", showForecast: false });
    expect(out.scenarioModelId).toBeUndefined();
    expect(costDisplayProblem({ ...out, forecast: out.showForecast })).toBeNull();
  });

  it("puts the date axis back, and falls back to it for count", () => {
    const saved: CostGraphConfig = {
      ...base,
      xAxis: "service",
      segmentByDate: true,
      groupBy: "none",
    };
    expect(applyCostReportRunOverrides(saved, { xAxis: "date" }).xAxis).toBeUndefined();
    const counted = applyCostReportRunOverrides(
      { ...saved, groupBy: "region", segmentByDate: false },
      { measure: "count" },
    );
    expect(counted.xAxis).toBeUndefined();
  });
});

describe("X axis display rules", () => {
  it("accepts a dimension X axis with a segment", () => {
    expect(costDisplayProblem({ ...base, xAxis: "service", groupBy: "region" })).toBeNull();
    expect(
      costDisplayProblem({ ...base, xAxis: "service", groupBy: "none", segmentByDate: true }),
    ).toBeNull();
  });

  it("refuses what needs a time axis", () => {
    expect(costDisplayProblem({ ...base, xAxis: "service", forecast: true })).toMatch(
      /date X axis/,
    );
    expect(costDisplayProblem({ ...base, xAxis: "service", cumulative: true })).toMatch(
      /date X axis/,
    );
    expect(
      costDisplayProblem({ ...base, xAxis: "service", groupBy: "region", measure: "count" }),
    ).toMatch(/date X axis/);
    expect(costDisplayProblem({ ...base, xAxis: "service", unitCostMetricId: "m" })).toMatch(
      /date X axis/,
    );
  });

  it("refuses a keyed axis without a key, a repeated dimension, and a double segment", () => {
    expect(costDisplayProblem({ ...base, xAxis: "tag" })).toMatch(/key/);
    expect(costDisplayProblem({ ...base, xAxis: "provider", groupBy: "provider" })).toMatch(
      /different dimension/,
    );
    expect(
      costDisplayProblem({
        ...base,
        xAxis: "tag",
        xAxisTagKey: "team",
        groupBy: "tag",
        groupByTagKey: "env",
      }),
    ).toBeNull();
    expect(
      costDisplayProblem({ ...base, xAxis: "service", groupBy: "region", segmentByDate: true }),
    ).toMatch(/not both/);
    expect(costDisplayProblem({ ...base, xAxis: "service", chartType: "pie" })).toMatch(/Pie/);
  });

  it("sends the axis only when set, and never for a pie", () => {
    const today = new Date("2026-07-15T00:00:00Z");
    expect(costQueryForConfig(base, today)).not.toHaveProperty("xAxis");
    expect(
      costQueryForConfig(
        { ...base, xAxis: "tag", xAxisTagKey: "team", groupBy: "none", segmentByDate: true },
        today,
      ),
    ).toMatchObject({ xAxis: "tag", xAxisTagKey: "team", segmentByDate: true });
    expect(
      costQueryForConfig({ ...base, xAxis: "service", chartType: "pie" }, today),
    ).not.toHaveProperty("xAxis");
    // A segment dimension wins over a stale date segment flag.
    expect(
      costQueryForConfig(
        { ...base, xAxis: "service", groupBy: "region", segmentByDate: true },
        today,
      ),
    ).not.toHaveProperty("segmentByDate");
  });
});
