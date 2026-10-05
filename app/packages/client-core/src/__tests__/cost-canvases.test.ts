import { describe, expect, it } from "vitest";
import {
  costCanvasChangePercent,
  costCanvasNameFromPrompt,
  costCanvasTableFromResponse,
  costCanvasTextReferences,
  describeCostCanvasChanges,
  diffCostCanvasSpecs,
  formatCostCanvasKpi,
  renderCostCanvasText,
  type CostCanvasBlock,
  type CostCanvasKpiValue,
  type CostCanvasSpec,
} from "../cost-canvases";

const kpi = (id: string, title: string): CostCanvasBlock => ({
  id,
  kind: "kpi",
  title,
  metric: { type: "spend", dateRange: { kind: "relative", preset: "mtd" }, filters: [] },
});
const text = (id: string, body: string): CostCanvasBlock => ({ id, kind: "text", text: body });
const spec = (...blocks: CostCanvasBlock[]): CostCanvasSpec => ({ version: 1, blocks });

describe("renderCostCanvasText", () => {
  const kpis = new Map<string, CostCanvasKpiValue | null>([
    ["spend", { value: 1234, unit: "money", currency: "USD", changePercent: 12.34 }],
    ["empty", null],
  ]);

  it("fills values and changes, never leaving template syntax", () => {
    expect(renderCostCanvasText("Spend {{spend}} ({{spend.change}})", kpis)).toMatch(
      /Spend \$1,234 \(\+12\.3%\)/,
    );
    expect(renderCostCanvasText("Missing {{nope}} and {{empty}}", kpis)).toBe("Missing - and -");
  });

  it("lists referenced ids once", () => {
    expect(costCanvasTextReferences("{{a}} {{ a.change }} {{b}}")).toEqual(["a", "b"]);
  });
});

describe("diffCostCanvasSpecs", () => {
  it("reports adds, removes, changes and moves by block id", () => {
    const before = spec(kpi("a", "Spend"), kpi("b", "Forecast"), text("t", "# Intro"));
    const after = spec(kpi("b", "Forecast"), kpi("a", "Spend this month"), kpi("c", "New"));
    const changes = diffCostCanvasSpecs(before, after);
    expect(changes).toContainEqual(
      expect.objectContaining({ type: "changed", blockId: "a", fields: ["title"] }),
    );
    expect(changes).toContainEqual(expect.objectContaining({ type: "added", blockId: "c" }));
    expect(changes).toContainEqual(expect.objectContaining({ type: "removed", blockId: "t" }));
    expect(changes.filter((c) => c.type === "moved")).toHaveLength(1);
  });

  it("does not report every block as moved after one insertion", () => {
    const before = spec(kpi("a", "A"), kpi("b", "B"), kpi("c", "C"));
    const after = spec(kpi("x", "X"), kpi("a", "A"), kpi("b", "B"), kpi("c", "C"));
    const changes = diffCostCanvasSpecs(before, after);
    expect(changes).toEqual([expect.objectContaining({ type: "added", blockId: "x" })]);
  });

  it("describes no change and renames", () => {
    const s = spec(kpi("a", "A"));
    expect(describeCostCanvasChanges(diffCostCanvasSpecs(s, s))).toEqual([
      "No changes to the canvas.",
    ]);
    expect(describeCostCanvasChanges([], { nameBefore: "Old", nameAfter: "New" })[0]).toContain(
      'Renamed "Old" to "New"',
    );
  });
});

describe("costCanvasTableFromResponse", () => {
  const response = {
    series: [
      {
        key: "team-a",
        label: "Team A",
        currency: "USD",
        points: [
          { bucket: "2026-08-01", amount: 10 },
          { bucket: "2026-09-01", amount: 20 },
        ],
      },
      {
        key: "__other__",
        label: "Other",
        currency: "USD",
        points: [{ bucket: "2026-09-01", amount: 100 }],
      },
      {
        key: "team-b",
        label: "Team B",
        currency: "USD",
        points: [{ bucket: "2026-09-01", amount: 50 }],
      },
      {
        key: "team-e",
        label: "Team E",
        currency: "EUR",
        points: [{ bucket: "2026-09-01", amount: 1 }],
      },
    ],
    totals: { USD: 180, EUR: 1 },
  };

  it("pivots buckets into columns, sorts by total with Other last", () => {
    const t = costCanvasTableFromResponse(response, "monthly", {
      from: "2026-08-01",
      to: "2026-09-30",
    });
    expect(t.columns).toEqual(["2026-08-01", "2026-09-01"]);
    expect(t.rows.map((r) => r.key)).toEqual(["team-b", "team-a", "__other__"]);
    expect(t.rows[1]!.values).toEqual([10, 20]);
    expect(t.currency).toBe("USD");
    expect(t.otherCurrencies).toEqual(["EUR"]);
  });

  it("collapses to one total column for binning none", () => {
    const t = costCanvasTableFromResponse(response, "none", { from: "a", to: "b" });
    expect(t.columns).toEqual(["total"]);
    expect(t.rows.find((r) => r.key === "team-a")!.values).toEqual([30]);
  });
});

describe("helpers", () => {
  it("derives a bounded name from a prompt", () => {
    expect(costCanvasNameFromPrompt("monthly AI spend by team. With extra words.")).toBe(
      "Monthly AI spend by team",
    );
    expect(costCanvasNameFromPrompt("   ")).toBe("Untitled canvas");
    expect(costCanvasNameFromPrompt("x ".repeat(80)).length).toBeLessThanOrEqual(61);
  });

  it("has no percent change against a zero or missing baseline", () => {
    expect(costCanvasChangePercent(10, 0)).toBeNull();
    expect(costCanvasChangePercent(10, null)).toBeNull();
    expect(costCanvasChangePercent(15, 10)).toBe(50);
  });

  it("formats each KPI unit and a missing value", () => {
    expect(formatCostCanvasKpi(null)).toBe("-");
    expect(formatCostCanvasKpi({ value: 42.4, unit: "percent" })).toBe("42%");
    expect(formatCostCanvasKpi({ value: 3, unit: "count" })).toBe("3");
    expect(
      formatCostCanvasKpi({
        value: 0.37,
        unit: "money_per_unit",
        currency: "USD",
        perUnit: "user",
      }),
    ).toBe("$0.37 / user");
  });
});
