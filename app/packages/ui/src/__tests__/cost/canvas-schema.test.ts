import { describe, expect, it } from "vitest";
import {
  costCanvasSpecSchema,
  formatCostCanvasSpecIssues,
  widgetConfigSchemaFor,
} from "../../cost/config.js";

const kpi = {
  id: "mtd",
  kind: "kpi",
  title: "Spend this month",
  metric: { type: "spend", dateRange: { kind: "relative", preset: "mtd" } },
};

describe("costCanvasSpecSchema", () => {
  it("accepts a typical model-written spec and applies defaults", () => {
    const parsed = costCanvasSpecSchema.parse({
      version: 1,
      blocks: [
        { id: "intro", kind: "text", text: "## AI spend\nThis month: {{mtd}} ({{mtd.change}})" },
        { ...kpi, comparePreviousPeriod: true },
        {
          id: "by-team",
          kind: "table",
          title: "AI spend by team",
          query: {
            dateRange: { kind: "relative", preset: "6m" },
            binning: "monthly",
            groupBy: "tag",
            groupByTagKey: "team",
            filters: [{ dimension: "provider", op: "in", values: ["openai"] }],
          },
        },
        { id: "anoms", kind: "anomalies", title: "Anomalies" },
      ],
    });
    const table = parsed.blocks[2] as { query: { topN: number } };
    expect(table.query.topN).toBe(10);
    const anomalies = parsed.blocks[3] as { days: number; limit: number };
    expect(anomalies).toMatchObject({ days: 30, limit: 10 });
  });

  it("rejects unknown keys anywhere, so a model cannot smuggle in a query string", () => {
    const res = costCanvasSpecSchema.safeParse({
      version: 1,
      blocks: [{ ...kpi, sql: "SELECT 1" }],
    });
    expect(res.success).toBe(false);
    const nested = costCanvasSpecSchema.safeParse({
      version: 1,
      blocks: [{ ...kpi, metric: { ...kpi.metric, query: "provider = 'aws'" } }],
    });
    expect(nested.success).toBe(false);
  });

  it("checks cross-block references and ids", () => {
    const res = costCanvasSpecSchema.safeParse({
      version: 1,
      blocks: [kpi, { ...kpi }, { id: "t", kind: "text", text: "{{missing}}" }],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = formatCostCanvasSpecIssues(res.error);
      expect(msg).toContain('duplicate block id "mtd"');
      expect(msg).toContain("{{missing}} does not name a kpi block");
    }
  });

  it("requires a tag key when grouping or filtering by tag", () => {
    const res = costCanvasSpecSchema.safeParse({
      version: 1,
      blocks: [
        {
          id: "t",
          kind: "table",
          title: "x",
          query: {
            dateRange: { kind: "relative", preset: "30d" },
            binning: "none",
            groupBy: "tag",
          },
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it("bounds the number of blocks", () => {
    const blocks = Array.from({ length: 25 }, (_, i) => ({ ...kpi, id: `k${i}` }));
    expect(costCanvasSpecSchema.safeParse({ version: 1, blocks }).success).toBe(false);
  });

  it("validates the dashboard widget config", () => {
    expect(
      widgetConfigSchemaFor("cost_canvas").safeParse({ version: 1, canvasId: "c1" }).success,
    ).toBe(true);
  });
});
