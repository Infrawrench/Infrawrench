/**
 * Cost canvases (POST/PUT /cost-canvases) and the spec the chat agent writes,
 * as Effect schemas.
 *
 * The zod twins are `.strict()` throughout: the spec is model-authored, and
 * a key the schema does not know is a mistake to report back to the model,
 * never a field to carry along silently. Decode these with
 * `STRICT_PARSE_OPTIONS` (`./primitives`); see there for why strictness is a
 * parse option rather than part of the schema. Nothing here takes a query
 * string or SQL; filters are the structured terms every cost surface uses.
 */
import { Effect, Predicate, Schema, SchemaIssue } from "effect";
import {
  COST_CANVAS_LIMITS,
  COST_CANVAS_TABLE_BINNINGS,
  COST_DIMENSIONS,
  costCanvasTextReferences,
  type CostCanvasBlock as CostCanvasBlockContract,
  type CostCanvasInput as CostCanvasInputContract,
  type CostCanvasKpiMetric as CostCanvasKpiMetricContract,
  type CostCanvasSpec as CostCanvasSpecContract,
  type CostCanvasTableQuery as CostCanvasTableQueryContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, pattern, trimmed } from "./checks";
import type { Exact } from "./contract";
import { CostBasisValue, CostDateRange } from "./cost-enums";
import { CostReportFilter, costGraphConfigCheck, costGraphConfigFields } from "./cost-graph";

const L = COST_CANVAS_LIMITS;

const BlockId = Schema.String.check(
  minLength(1),
  maxLength(L.maxBlockIdLength),
  pattern(/^[A-Za-z0-9_-]+$/, { message: "block ids are letters, digits, '-' and '_'" }),
).annotate({ description: "Stable within the spec; text blocks reference KPI ids as `{{id}}`." });
const Title = Schema.String.check(minLength(1), maxLength(L.maxBlockTitleLength));
const Filters = Schema.mutable(Schema.Array(CostReportFilter))
  .check(maxLength(20))
  .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => [])));
const Ref = Schema.String.check(minLength(1), maxLength(200));
const AnomalyDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: L.maxAnomalyDays }));

/** What a KPI block measures. Documented as `anyOf`, as the Zod spec's `z.union` was. */
export const CostCanvasKpiMetric = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("spend"),
    dateRange: CostDateRange,
    filters: Filters,
    savedFilterId: Schema.optionalKey(Ref),
    costBasis: Schema.optionalKey(CostBasisValue),
    adjusted: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("unit_cost"),
    businessMetricId: Ref.annotate({
      description: "A business metric id (see /business-metrics).",
    }),
    dateRange: CostDateRange,
    filters: Filters,
    savedFilterId: Schema.optionalKey(Ref),
    costBasis: Schema.optionalKey(CostBasisValue),
  }),
  Schema.Struct({
    type: Schema.Literal("forecast"),
    filters: Filters,
    savedFilterId: Schema.optionalKey(Ref),
  }),
  Schema.Struct({ type: Schema.Literal("budget"), budgetId: Ref }),
  Schema.Struct({ type: Schema.Literal("anomaly_count"), days: AnomalyDays }),
]).annotate({ identifier: "CostCanvasKpiMetric" });

export const CostCanvasTableQuery = Schema.Struct({
  dateRange: CostDateRange,
  binning: Schema.Literals(COST_CANVAS_TABLE_BINNINGS),
  groupBy: Schema.Literals(COST_DIMENSIONS),
  groupByTagKey: Schema.optionalKey(Schema.String.check(minLength(1))),
  filters: Filters,
  savedFilterId: Schema.optionalKey(Ref),
  costBasis: Schema.optionalKey(CostBasisValue),
  adjusted: Schema.optionalKey(Schema.Boolean),
  topN: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: L.maxTableRows })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(10)),
  ),
}).annotate({ identifier: "CostCanvasTableQuery" });

/** One block of a canvas. Documented as `anyOf`, as the Zod spec's `z.union` was. */
export const CostCanvasBlock = Schema.Union([
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("text"),
    text: Schema.String.check(minLength(1), maxLength(L.maxTextLength)).annotate({
      description: "Short narrative; `{{kpiId}}` / `{{kpiId.change}}` render that KPI's figure.",
    }),
  }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("kpi"),
    title: Title,
    metric: CostCanvasKpiMetric,
    comparePreviousPeriod: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("chart"),
    title: Title,
    // Held to the same display rules as a stored card (a usage chart names its unit, and so on).
    config: Schema.Struct(costGraphConfigFields).check(costGraphConfigCheck).annotate({
      description: "A cost graph config, the same object a `cost_graph` dashboard widget stores.",
    }),
  }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("table"),
    title: Title,
    query: CostCanvasTableQuery,
  }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("budgets"),
    title: Title,
    budgetIds: Schema.optionalKey(
      Schema.mutable(Schema.Array(Ref)).check(maxLength(L.maxBudgetsPerBlock)),
    ),
  }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("anomalies"),
    title: Title,
    days: AnomalyDays.pipe(Schema.withDecodingDefaultKey(Effect.succeed(30))),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: L.maxAnomalyRows })).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(10)),
    ),
  }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("cost_report"),
    title: Schema.optionalKey(Title),
    reportId: Ref,
  }),
  Schema.Struct({
    id: BlockId,
    kind: Schema.Literal("custom_graph"),
    title: Schema.optionalKey(Title),
    graphId: Ref,
  }),
]).annotate({ identifier: "CostCanvasBlock" });

function tagKeyIssue(
  filters: ReadonlyArray<{ readonly dimension: string; readonly tagKey?: string }>,
): string | null {
  return filters.some((f) => f.dimension === "tag" && !f.tagKey)
    ? "a tag filter needs tagKey"
    : null;
}

/**
 * The spec's cross-block rules, every one reported (as zod's `superRefine`
 * did): duplicate ids, text references to KPIs that do not exist, tag filters
 * without a key, and options a block's kind cannot use.
 */
const specCheck = Schema.makeFilter(
  (spec: { readonly blocks: ReadonlyArray<typeof CostCanvasBlock.Type> }) => {
    const issues: Array<{ path: ReadonlyArray<PropertyKey>; issue: string }> = [];
    const ids = new Set<string>();
    const kpiIds = new Set(spec.blocks.filter((b) => b.kind === "kpi").map((b) => b.id));
    spec.blocks.forEach((block, i) => {
      const fail = (message: string, field: string) =>
        issues.push({ path: ["blocks", i, field], issue: message });
      if (ids.has(block.id)) fail(`duplicate block id "${block.id}"`, "id");
      ids.add(block.id);
      switch (block.kind) {
        case "text":
          for (const ref of costCanvasTextReferences(block.text)) {
            if (!kpiIds.has(ref)) fail(`{{${ref}}} does not name a kpi block`, "text");
          }
          break;
        case "kpi": {
          const m = block.metric;
          if ("filters" in m) {
            const issue = tagKeyIssue(m.filters);
            if (issue) fail(issue, "metric");
          }
          if (block.comparePreviousPeriod && m.type !== "spend" && m.type !== "unit_cost") {
            fail(
              "comparePreviousPeriod only applies to spend and unit_cost",
              "comparePreviousPeriod",
            );
          }
          break;
        }
        case "chart": {
          const c = block.config;
          if (c.groupBy === "tag" && !c.groupByTagKey)
            fail("groupBy tag needs groupByTagKey", "config");
          const issue = tagKeyIssue(c.filters);
          if (issue) fail(issue, "config");
          if (c.scenarioModelId && !c.showForecast)
            fail("scenarioModelId needs showForecast", "config");
          break;
        }
        case "table": {
          const q = block.query;
          if (q.groupBy === "tag" && !q.groupByTagKey)
            fail("groupBy tag needs groupByTagKey", "query");
          const issue = tagKeyIssue(q.filters);
          if (issue) fail(issue, "query");
          break;
        }
        default:
          break;
      }
    });
    return issues;
  },
);

export const CostCanvasSpec = Schema.Struct({
  version: Schema.Literal(1),
  blocks: Schema.mutable(Schema.Array(CostCanvasBlock)).check(maxLength(L.maxBlocks)),
})
  .check(specCheck)
  .annotate({
    identifier: "CostCanvasSpec",
    description:
      "The structured query spec. It holds queries, never numbers: running the canvas " +
      "re-executes every block, so a refresh needs no model call. Validated strictly on write; " +
      "there is no field that takes a query string or SQL.",
  });

export const CostCanvasInput = Schema.Struct({
  name: trimmed([minLength(1), maxLength(L.maxNameLength)]),
  description: Schema.optionalKey(Schema.String.check(maxLength(L.maxDescriptionLength))),
  spec: CostCanvasSpec,
}).annotate({ identifier: "CostCanvasInput" });

export const CostCanvasDraftInput = Schema.Struct({
  prompt: trimmed([minLength(1), maxLength(L.maxPromptLength)], {
    description: "What the report should show, in plain words.",
  }),
  name: Schema.optionalKey(trimmed([minLength(1), maxLength(L.maxNameLength)])),
  model: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(80)).annotate({
      description: "A chat model id; the chat default when absent.",
    }),
  ),
}).annotate({ identifier: "CostCanvasDraftInput" });

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * A spec failure as one readable string, for the agent's tool error (it has
 * to fix the spec from this alone) and the API's 400: zod's
 * `formatCostCanvasSpecIssues`, over an Effect issue. Decode with
 * `{ ...STRICT_PARSE_OPTIONS, errors: "all" }` to report every problem.
 */
export function formatCostCanvasSpecSchemaIssues(issue: SchemaIssue.Issue): string {
  return formatIssues(issue)
    .issues.slice(0, 12)
    .map((i) => {
      const path = (i.path ?? []).map((segment) =>
        String(Predicate.isPropertyKey(segment) ? segment : segment.key),
      );
      return `${path.length > 0 ? path.join(".") : "(spec)"}: ${i.message}`;
    })
    .join("; ");
}

export type CostCanvasSchemasMatchContract = [
  Exact<typeof CostCanvasKpiMetric.Type, CostCanvasKpiMetricContract>,
  Exact<typeof CostCanvasTableQuery.Type, CostCanvasTableQueryContract>,
  Exact<typeof CostCanvasBlock.Type, CostCanvasBlockContract>,
  Exact<typeof CostCanvasSpec.Type, CostCanvasSpecContract>,
  Exact<typeof CostCanvasInput.Type, CostCanvasInputContract>,
];
[true, true, true, true, true] satisfies CostCanvasSchemasMatchContract;
