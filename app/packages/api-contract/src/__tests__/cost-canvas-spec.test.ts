import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CostCanvasSpec,
  STRICT_PARSE_OPTIONS,
  formatCostCanvasSpecSchemaIssues,
  widgetConfigFor,
} from "../schemas";

/** A spec decoded as the route and the agent's tool decode one: strict, every problem. */
const decodeSpec = (spec: unknown) =>
  Schema.decodeUnknownResult(CostCanvasSpec)(spec, { ...STRICT_PARSE_OPTIONS, errors: "all" });

const kpi = {
  id: "mtd",
  kind: "kpi",
  title: "Spend this month",
  metric: { type: "spend", dateRange: { kind: "relative", preset: "mtd" } },
};

describe("CostCanvasSpec", () => {
  it("accepts a typical model-written spec and applies defaults", () => {
    const parsed = Schema.decodeUnknownSync(CostCanvasSpec)({
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
    const res = decodeSpec({
      version: 1,
      blocks: [{ ...kpi, sql: "SELECT 1" }],
    });
    expect(Result.isFailure(res)).toBe(true);
    const nested = decodeSpec({
      version: 1,
      blocks: [{ ...kpi, metric: { ...kpi.metric, query: "provider = 'aws'" } }],
    });
    expect(Result.isFailure(nested)).toBe(true);
  });

  it("checks cross-block references and ids", () => {
    const res = decodeSpec({
      version: 1,
      blocks: [kpi, { ...kpi }, { id: "t", kind: "text", text: "{{missing}}" }],
    });
    expect(Result.isFailure(res)).toBe(true);
    if (Result.isFailure(res)) {
      const msg = formatCostCanvasSpecSchemaIssues(res.failure.issue);
      expect(msg).toContain('duplicate block id "mtd"');
      expect(msg).toContain("{{missing}} does not name a kpi block");
    }
  });

  it("requires a tag key when grouping or filtering by tag", () => {
    const res = decodeSpec({
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
    expect(Result.isFailure(res)).toBe(true);
  });

  it("bounds the number of blocks", () => {
    const blocks = Array.from({ length: 25 }, (_, i) => ({ ...kpi, id: `k${i}` }));
    expect(Result.isFailure(decodeSpec({ version: 1, blocks }))).toBe(true);
  });

  it("validates the dashboard widget config", () => {
    expect(Schema.is(widgetConfigFor("cost_canvas"))({ version: 1, canvasId: "c1" })).toBe(true);
  });
});
