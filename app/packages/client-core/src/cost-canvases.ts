/**
 * Cost canvases: natural-language report builder output.
 *
 * A person describes a report ("monthly AI spend by team for the last six
 * months, with cost per active user") and the chat agent writes a canvas: a
 * named, saved **structured spec** of blocks (KPI tiles, charts, tables,
 * budgets, anomalies, short narrative text, saved reports and custom graphs).
 *
 * The spec never holds a number. Every figure on a canvas is produced by
 * re-running the spec's queries through the same services the rest of the
 * cost UI uses, which is what makes "Refresh" deterministic and free of any
 * model call: the model is only involved when the spec is created or edited,
 * and an edit is a proposal the user approves after seeing the diff.
 *
 * The spec is validated with a strict zod schema at every write
 * (`ui/src/cost/canvas-schema.ts`, asserted `Exact` against these types).
 * There is deliberately no block that carries a query string: filters are
 * structured `CostFilter[]`, so nothing the model writes can become SQL.
 *
 * These types live here rather than in `@infrawrench/ui` because mobile and
 * the CLI render canvases too and do not depend on that package.
 */

import type { BudgetWithStatus } from "./costs";
import type {
  CostBasis,
  CostDateRange,
  CostDimensionId,
  CostFilter,
  CostGraphConfig,
  CostQueryResponse,
} from "./costs";
import type { UnitCostQueryResponse } from "./business-metrics";
import type { CostAnomaly } from "./cost-anomalies";
import type { CustomGraphRenderSpec } from "./custom-graphs";
import type {
  DashboardNotification,
  DashboardNotificationInput,
  DashboardNotificationSendResult,
} from "./report-notifications";
import type { CloudFetch } from "./fetch";

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** Bounds the API enforces on a canvas and its spec. */
export const COST_CANVAS_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 1000,
  /** The prompt the canvas was first described with. */
  maxPromptLength: 4000,
  /** A canvas is a page, not a warehouse: past this it stops being readable. */
  maxBlocks: 24,
  maxBlockTitleLength: 120,
  /** Narrative text is meant to be short: a heading and a sentence or two. */
  maxTextLength: 2000,
  maxBlockIdLength: 40,
  maxBudgetsPerBlock: 12,
  maxTableRows: 50,
  maxAnomalyDays: 90,
  maxAnomalyRows: 50,
  /** Schedules per canvas, matching dashboards. */
  maxNotificationsPerCanvas: 10,
} as const;

/* ------------------------------------------------------------------ *
 * Spec
 * ------------------------------------------------------------------ */

export const COST_CANVAS_BLOCK_KINDS = [
  "text",
  "kpi",
  "chart",
  "table",
  "budgets",
  "anomalies",
  "cost_report",
  "custom_graph",
] as const;
export type CostCanvasBlockKind = (typeof COST_CANVAS_BLOCK_KINDS)[number];

export const COST_CANVAS_KPI_TYPES = [
  "spend",
  "unit_cost",
  "forecast",
  "budget",
  "anomaly_count",
] as const;
export type CostCanvasKpiType = (typeof COST_CANVAS_KPI_TYPES)[number];

/** Scope shared by spend-shaped queries: the same fields a cost graph carries. */
export interface CostCanvasScope {
  filters: CostFilter[];
  savedFilterId?: string | undefined;
  costBasis?: CostBasis | undefined;
  /** Billing rules applied, like `CostGraphConfig.adjusted`. */
  adjusted?: boolean | undefined;
}

/** What a KPI tile measures. */
export type CostCanvasKpiMetric =
  | ({ type: "spend"; dateRange: CostDateRange } & CostCanvasScope)
  | {
      type: "unit_cost";
      /** A `business_metrics` id: the denominator. */
      businessMetricId: string;
      dateRange: CostDateRange;
      filters: CostFilter[];
      savedFilterId?: string | undefined;
      costBasis?: CostBasis | undefined;
    }
  /** Projected month-end spend for the current month. */
  | { type: "forecast"; filters: CostFilter[]; savedFilterId?: string | undefined }
  /** Percent of a budget used this month. */
  | { type: "budget"; budgetId: string }
  /** How many cost anomalies were detected in the trailing window. */
  | { type: "anomaly_count"; days: number };

export const COST_CANVAS_TABLE_BINNINGS = ["none", "daily", "weekly", "monthly"] as const;
export type CostCanvasTableBinning = (typeof COST_CANVAS_TABLE_BINNINGS)[number];

/** A grouped spend table: one row per group, one column per bucket. */
export interface CostCanvasTableQuery extends CostCanvasScope {
  dateRange: CostDateRange;
  /** `none` collapses the range into one total column. */
  binning: CostCanvasTableBinning;
  groupBy: CostDimensionId;
  /** Required when groupBy === "tag". */
  groupByTagKey?: string | undefined;
  /** Rows beyond this fold into "Other". */
  topN: number;
}

interface BlockBase {
  /** Stable within the spec; text blocks reference KPI ids as `{{id}}`. */
  id: string;
}

export type CostCanvasBlock =
  | (BlockBase & {
      kind: "text";
      /**
       * Short narrative. Plain text with `#`/`##` headings, `**bold**` and `-`
       * bullets. `{{kpiId}}` is replaced by that KPI's formatted value and
       * `{{kpiId.change}}` by its change against the previous period, so
       * prose can quote a figure without freezing it.
       */
      text: string;
    })
  | (BlockBase & {
      kind: "kpi";
      title: string;
      metric: CostCanvasKpiMetric;
      /** Show change against the same-length window before (spend/unit_cost only). */
      comparePreviousPeriod?: boolean | undefined;
    })
  | (BlockBase & { kind: "chart"; title: string; config: CostGraphConfig })
  | (BlockBase & { kind: "table"; title: string; query: CostCanvasTableQuery })
  | (BlockBase & {
      kind: "budgets";
      title: string;
      /** Absent or empty: every budget the reader can see. */
      budgetIds?: string[] | undefined;
    })
  | (BlockBase & { kind: "anomalies"; title: string; days: number; limit: number })
  | (BlockBase & { kind: "cost_report"; title?: string | undefined; reportId: string })
  | (BlockBase & {
      kind: "custom_graph";
      title?: string | undefined;
      /**
       * A saved custom graph: the way a canvas carries data from other
       * connected tools (resource metrics, provider APIs) deterministically.
       */
      graphId: string;
    });

export interface CostCanvasSpec {
  version: 1;
  blocks: CostCanvasBlock[];
}

export const EMPTY_COST_CANVAS_SPEC: CostCanvasSpec = { version: 1, blocks: [] };

/* ------------------------------------------------------------------ *
 * Objects
 * ------------------------------------------------------------------ */

/** One dashboard card pointing at a canvas. */
export interface CostCanvasPlacement {
  widgetId: string;
  dashboardId: string;
  dashboardName: string;
}

export interface CostCanvas {
  id: string;
  name: string;
  description: string | null;
  spec: CostCanvasSpec;
  /** What the canvas was first described as; null for a canvas written directly. */
  prompt: string | null;
  /**
   * The caller's most recent unarchived chat conversation for this canvas,
   * or null. Chat history is per user, so every editor gets their own.
   */
  conversationId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  placements: CostCanvasPlacement[];
}

/** Full-replace body for PUT /cost-canvases/:id and POST /cost-canvases. */
export interface CostCanvasInput {
  name: string;
  description?: string | undefined;
  spec: CostCanvasSpec;
}

/**
 * POST /cost-canvases/draft: start a canvas from a prompt. The canvas is
 * created empty and linked to a new chat conversation; the client then sends
 * `prompt` as that conversation's first message and the agent writes the spec.
 */
export interface CostCanvasDraftInput {
  prompt: string;
  /** Optional; derived from the prompt when absent. */
  name?: string | undefined;
  /** A `CHAT_MODELS` id; the chat default when absent. */
  model?: string | undefined;
}

/** A `cost_canvas` dashboard widget is a view onto a canvas row. */
export interface CostCanvasWidgetConfig {
  version: 1;
  canvasId: string;
}

/* ------------------------------------------------------------------ *
 * Run results
 * ------------------------------------------------------------------ */

export type CostCanvasKpiUnit = "money" | "money_per_unit" | "percent" | "count";

export interface CostCanvasKpiValue {
  /** Null when there is no honest number (no denominator, no data). */
  value: number | null;
  unit: CostCanvasKpiUnit;
  /** For money units. */
  currency?: string | undefined;
  /** The denominator's unit label for `money_per_unit` ("active user"). */
  perUnit?: string | undefined;
  /** Previous-period value, when compared. */
  previous?: number | null | undefined;
  /** Percent change against `previous`; null when it has no meaning. */
  changePercent?: number | null | undefined;
  /** Inclusive window the value covers, when it has one. */
  from?: string | undefined;
  to?: string | undefined;
  /** A caveat worth printing under the tile (mixed currencies, gaps). */
  note?: string | undefined;
}

export interface CostCanvasTableRow {
  key: string;
  label: string;
  /** One value per column. */
  values: number[];
  total: number;
}

export interface CostCanvasTableResult {
  /** Bucket start dates (YYYY-MM-DD), or `["total"]` for binning `none`. */
  columns: string[];
  rows: CostCanvasTableRow[];
  currency: string | null;
  /** Other currencies present but not shown in this table. */
  otherCurrencies: string[];
  from: string;
  to: string;
}

export type CostCanvasBlockResult =
  | { id: string; kind: "text"; text: string; error?: string | undefined }
  | { id: string; kind: "kpi"; kpi: CostCanvasKpiValue | null; error?: string | undefined }
  | {
      id: string;
      kind: "chart";
      from: string;
      to: string;
      /** Omitted when the caller asked for no chart data (the live UI queries itself). */
      cost?: CostQueryResponse | undefined;
      unitCost?: UnitCostQueryResponse | undefined;
      error?: string | undefined;
    }
  | { id: string; kind: "table"; table: CostCanvasTableResult | null; error?: string | undefined }
  | {
      id: string;
      kind: "budgets";
      budgets: BudgetWithStatus[];
      /** Requested ids the reader cannot see or that no longer exist. */
      missing: string[];
      error?: string | undefined;
    }
  | {
      id: string;
      kind: "anomalies";
      anomalies: CostAnomaly[];
      /**
       * True when the reader's cost visibility is scoped: stored org-wide
       * findings are withheld from scoped callers.
       */
      withheld: boolean;
      error?: string | undefined;
    }
  | {
      id: string;
      kind: "cost_report";
      report: {
        id: string;
        name: string;
        description: string | null;
        config: CostGraphConfig;
      } | null;
      from?: string | undefined;
      to?: string | undefined;
      cost?: CostQueryResponse | undefined;
      unitCost?: UnitCostQueryResponse | undefined;
      error?: string | undefined;
    }
  | {
      id: string;
      kind: "custom_graph";
      graph: { id: string; name: string } | null;
      spec: CustomGraphRenderSpec | null;
      error?: string | undefined;
    };

/** POST /cost-canvases/:id/run (and /cost-canvases/preview). */
export interface CostCanvasRunResult {
  canvasId: string | null;
  name: string;
  /** When the queries ran; nothing about the canvas is cached. */
  ranAt: string;
  /** The org's display currency when amounts were converted. */
  displayCurrency: string | null;
  blocks: CostCanvasBlockResult[];
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

/** A canvas delivery schedule: the dashboard schedule shape, pointed at a canvas. */
export interface CostCanvasNotification extends Omit<DashboardNotification, "dashboardId"> {
  costCanvasId: string;
}
export type CostCanvasNotificationInput = DashboardNotificationInput;
export type CostCanvasNotificationSendResult = DashboardNotificationSendResult;

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** Trim and bound a canvas name; null when unusable. */
export function normalizeCostCanvasName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || name.length > COST_CANVAS_LIMITS.maxNameLength) return null;
  return name;
}

/** A working name from a prompt: its first sentence, bounded. */
export function costCanvasNameFromPrompt(prompt: string): string {
  const first =
    prompt
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s/)[0] ?? "";
  const cleaned = first.replace(/[.!?]+$/, "").trim();
  if (!cleaned) return "Untitled canvas";
  const max = 60;
  if (cleaned.length <= max) return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  const cut = cleaned.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const base = space > 20 ? cut.slice(0, space) : cut;
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}…`;
}

/** Percent change, or null when the baseline makes it meaningless. */
export function costCanvasChangePercent(
  current: number | null,
  previous: number | null | undefined,
): number | null {
  if (current === null || previous === null || previous === undefined) return null;
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Format a KPI value for display. Money uses the same rule as the rest of the
 * cost UI (`Intl` currency); a ratio keeps cents because a cost per user of
 * $0.37 is the whole point of the tile.
 */
export function formatCostCanvasKpi(kpi: CostCanvasKpiValue | null): string {
  if (!kpi || kpi.value === null) return "-";
  const v = kpi.value;
  switch (kpi.unit) {
    case "money":
    case "money_per_unit": {
      const digits = kpi.unit === "money_per_unit" || Math.abs(v) < 10 ? 2 : 0;
      let out: string;
      try {
        out = new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: kpi.currency || "USD",
          maximumFractionDigits: digits,
          minimumFractionDigits: digits === 2 ? 2 : 0,
        }).format(v);
      } catch {
        out = v.toFixed(digits);
      }
      return kpi.unit === "money_per_unit" && kpi.perUnit ? `${out} / ${kpi.perUnit}` : out;
    }
    case "percent":
      return `${Math.round(v)}%`;
    case "count":
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v);
  }
}

/** `+12.4%` / `-3.0%`, or null when there is no change to state. */
export function formatCostCanvasChange(changePercent: number | null | undefined): string | null {
  if (changePercent === null || changePercent === undefined || !Number.isFinite(changePercent)) {
    return null;
  }
  return `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(1)}%`;
}

const TOKEN_RE = /\{\{\s*([A-Za-z0-9_-]+)(?:\.(change))?\s*\}\}/g;

/**
 * Replace `{{kpiId}}` and `{{kpiId.change}}` tokens in narrative text with the
 * run's figures. An unknown id or a KPI with no value renders as `-`, never
 * as the raw token: a reader should not see template syntax.
 */
export function renderCostCanvasText(
  text: string,
  kpis: ReadonlyMap<string, CostCanvasKpiValue | null>,
): string {
  return text.replace(TOKEN_RE, (_m, id: string, field: string | undefined) => {
    const kpi = kpis.get(id) ?? null;
    if (field === "change") return formatCostCanvasChange(kpi?.changePercent) ?? "-";
    return formatCostCanvasKpi(kpi);
  });
}

/** The KPI ids a text block references, for validation and diffing. */
export function costCanvasTextReferences(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) out.add(m[1]!);
  return [...out];
}

/** The series currency a single-currency view should show: the largest total. */
export function primaryCostCurrency(response: Pick<CostQueryResponse, "totals">): string | null {
  let best: string | null = null;
  let bestTotal = -Infinity;
  for (const [currency, total] of Object.entries(response.totals)) {
    if (Math.abs(total) > bestTotal) {
      best = currency;
      bestTotal = Math.abs(total);
    }
  }
  return best;
}

/**
 * Pivot a grouped cost query response into a table: one row per group in the
 * primary currency, one column per bucket, sorted by total descending with
 * "Other" last. `binning: "none"` collapses every bucket into one column.
 */
export function costCanvasTableFromResponse(
  response: Pick<CostQueryResponse, "series" | "totals">,
  binning: CostCanvasTableBinning,
  window: { from: string; to: string },
): CostCanvasTableResult {
  const currency = primaryCostCurrency(response);
  const otherCurrencies = Object.keys(response.totals).filter((c) => c !== currency);
  const series = response.series.filter((s) => s.currency === currency);
  const columns =
    binning === "none"
      ? ["total"]
      : [...new Set(series.flatMap((s) => s.points.map((p) => p.bucket)))].sort();
  const index = new Map(columns.map((c, i) => [c, i]));
  const rows: CostCanvasTableRow[] = series.map((s) => {
    const values = new Array<number>(columns.length).fill(0);
    for (const p of s.points) {
      const i = binning === "none" ? 0 : (index.get(p.bucket) ?? -1);
      if (i >= 0) values[i] = (values[i] ?? 0) + p.amount;
    }
    const total = values.reduce((a, b) => a + b, 0);
    return { key: s.key, label: s.label || s.key || "Total", values, total };
  });
  rows.sort((a, b) => {
    if (a.key === "__other__") return 1;
    if (b.key === "__other__") return -1;
    return b.total - a.total;
  });
  return {
    columns,
    rows: rows.slice(0, COST_CANVAS_LIMITS.maxTableRows),
    currency,
    otherCurrencies,
    from: window.from,
    to: window.to,
  };
}

/* ------------------------------------------------------------------ *
 * Diff (what an edit changes, shown before the user accepts it)
 * ------------------------------------------------------------------ */

export interface CostCanvasSpecChange {
  type: "added" | "removed" | "changed" | "moved";
  blockId: string;
  kind: CostCanvasBlockKind;
  /** The block's title (or the first words of a text block). */
  label: string;
  /** For `changed`: the top-level fields whose value differs. */
  fields?: string[] | undefined;
}

export function costCanvasBlockLabel(block: CostCanvasBlock): string {
  if (block.kind === "text") {
    const line = block.text
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l.length > 0);
    if (!line) return "Text";
    return line.length > 48 ? `${line.slice(0, 47)}…` : line;
  }
  if ("title" in block && block.title) return block.title;
  if (block.kind === "cost_report") return "Saved report";
  if (block.kind === "custom_graph") return "Custom graph";
  return block.kind;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Block-level diff between two specs, matched by block id. Order changes are
 * reported once per block whose relative position among surviving blocks
 * moved, so a single insertion does not read as everything moving.
 */
export function diffCostCanvasSpecs(
  before: CostCanvasSpec,
  after: CostCanvasSpec,
): CostCanvasSpecChange[] {
  const changes: CostCanvasSpecChange[] = [];
  const beforeById = new Map(before.blocks.map((b) => [b.id, b]));
  const afterById = new Map(after.blocks.map((b) => [b.id, b]));

  for (const block of after.blocks) {
    const prev = beforeById.get(block.id);
    if (!prev) {
      changes.push({
        type: "added",
        blockId: block.id,
        kind: block.kind,
        label: costCanvasBlockLabel(block),
      });
      continue;
    }
    if (prev.kind !== block.kind) {
      changes.push({
        type: "changed",
        blockId: block.id,
        kind: block.kind,
        label: costCanvasBlockLabel(block),
        fields: ["kind"],
      });
      continue;
    }
    const keys = new Set([...Object.keys(prev), ...Object.keys(block)]);
    const fields: string[] = [];
    for (const key of keys) {
      if (key === "id") continue;
      const a = (prev as unknown as Record<string, unknown>)[key];
      const b = (block as unknown as Record<string, unknown>)[key];
      if (stableStringify(a) !== stableStringify(b)) fields.push(key);
    }
    if (fields.length > 0) {
      changes.push({
        type: "changed",
        blockId: block.id,
        kind: block.kind,
        label: costCanvasBlockLabel(block),
        fields: fields.sort(),
      });
    }
  }
  for (const block of before.blocks) {
    if (!afterById.has(block.id)) {
      changes.push({
        type: "removed",
        blockId: block.id,
        kind: block.kind,
        label: costCanvasBlockLabel(block),
      });
    }
  }

  // Moves: compare the order of blocks present on both sides.
  const keptBefore = before.blocks.filter((b) => afterById.has(b.id)).map((b) => b.id);
  const keptAfter = after.blocks.filter((b) => beforeById.has(b.id)).map((b) => b.id);
  if (keptBefore.join("\u0000") !== keptAfter.join("\u0000")) {
    // Longest increasing subsequence of before-positions = the blocks that
    // stayed put; everything else moved.
    const pos = new Map(keptBefore.map((id, i) => [id, i]));
    const seq = keptAfter.map((id) => pos.get(id)!);
    const stay = longestIncreasingSubsequence(seq);
    keptAfter.forEach((id, i) => {
      if (stay.has(i)) return;
      const block = afterById.get(id)!;
      changes.push({
        type: "moved",
        blockId: id,
        kind: block.kind,
        label: costCanvasBlockLabel(block),
      });
    });
  }
  return changes;
}

function longestIncreasingSubsequence(seq: number[]): Set<number> {
  const tails: number[] = [];
  const tailIdx: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  seq.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1]! : -1;
  });
  const out = new Set<number>();
  let k = tailIdx[tails.length - 1] ?? -1;
  while (k >= 0) {
    out.add(k);
    k = prev[k]!;
  }
  return out;
}

/**
 * The diff as plain lines, for the chat approval card and the CLI. English on
 * purpose: it is stored on the pending action server-side, like the rest of a
 * tool card's text.
 */
export function describeCostCanvasChanges(
  changes: CostCanvasSpecChange[],
  meta?: { nameBefore?: string; nameAfter?: string },
): string[] {
  const lines: string[] = [];
  if (meta?.nameBefore !== undefined && meta.nameAfter !== undefined) {
    if (meta.nameBefore !== meta.nameAfter) {
      lines.push(`~ Renamed "${meta.nameBefore}" to "${meta.nameAfter}"`);
    }
  }
  for (const c of changes) {
    const what = `${c.kind.replace("_", " ")} "${c.label}"`;
    switch (c.type) {
      case "added":
        lines.push(`+ Add ${what}`);
        break;
      case "removed":
        lines.push(`- Remove ${what}`);
        break;
      case "changed":
        lines.push(`~ Change ${what}: ${(c.fields ?? []).join(", ")}`);
        break;
      case "moved":
        lines.push(`↕ Move ${what}`);
        break;
    }
  }
  if (lines.length === 0) lines.push("No changes to the canvas.");
  return lines;
}

/* ------------------------------------------------------------------ *
 * Fetch helpers (mobile, CLI)
 * ------------------------------------------------------------------ */

export async function listCostCanvases(api: CloudFetch, orgId: string): Promise<CostCanvas[]> {
  return (await api.org<CostCanvas[]>(orgId, "/cost-canvases")) ?? [];
}

export async function getCostCanvas(
  api: CloudFetch,
  orgId: string,
  canvasId: string,
): Promise<CostCanvas | null> {
  return await api.org<CostCanvas>(orgId, `/cost-canvases/${encodeURIComponent(canvasId)}`);
}

export async function runCostCanvas(
  api: CloudFetch,
  orgId: string,
  canvasId: string,
  opts: { includeChartData?: boolean } = {},
): Promise<CostCanvasRunResult | null> {
  return await api.org<CostCanvasRunResult>(
    orgId,
    `/cost-canvases/${encodeURIComponent(canvasId)}/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeChartData: opts.includeChartData ?? true }),
    },
  );
}
