/**
 * Cost canvases: CRUD, sharing, conversations and deterministic execution.
 * Shared by the HTTP routes (api/routes/cost-canvases.ts), the tool registry
 * (tools/cost-canvases.ts), the PDF renderer and the delivery loop.
 *
 * A canvas stores a structured spec and never a number. `runCostCanvasSpec`
 * answers every block through the same service its standalone card uses
 * (`runCostQuery`, `runUnitCostQuery`, `listBudgetsWithStatus`,
 * `listRecentCostAnomalies`, `getCostReport`, `renderOrgCustomGraph`), inside
 * whatever cost visibility scope and sharing principal the caller's request
 * established, so a canvas can never show more than the reader could query
 * by hand, and refreshing one is a re-run with no model involved.
 *
 * The placement and soft-delete rules are the cost report's: a canvas
 * outlives its dashboard cards, and deleting the canvas removes them.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  EMPTY_COST_CANVAS_SPEC,
  costCanvasChangePercent,
  costCanvasNameFromPrompt,
  costCanvasTableFromResponse,
  costQueryForConfig,
  describeCostCanvasChanges,
  diffCostCanvasSpecs,
  primaryCostCurrency,
  renderCostCanvasText,
  resolveCostDateRange,
  isUnitCostConfig,
  unitCostQueryForConfig,
  type CostCanvas,
  type CostCanvasBlock,
  type CostCanvasBlockResult,
  type CostCanvasInput,
  type CostCanvasKpiValue,
  type CostCanvasPlacement,
  type CostCanvasRunResult,
  type CostCanvasSpec,
  type CostGraphConfig,
  type ObjectAccessLevel,
} from "@infrawrench/client-core";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from "@infrawrench/ui";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { getOrgCurrencySettings } from "@infrawrench/server-core/cost/currency-settings";
import { disableCanvasNotifications } from "@infrawrench/server-core/report-delivery/canvas";
import { db } from "../db/client";
import { chatConversations, costCanvases, dashboardWidgets, dashboards } from "../db/schema";
import {
  deleteObjectSharing,
  filterVisibleObjects,
  ObjectNotVisibleError,
  requireObjectAccess,
} from "./object-sharing";
import { runCostQuery } from "./cost-query";
import { runUnitCostQuery, runUsageUnitCostQuery } from "./unit-cost-query";
import { listBudgetsWithStatus, getBudgetWithStatus } from "./budgets";
import { listRecentCostAnomalies } from "./cost-anomalies";
import { withholdOrgWideFindings } from "./cost-visibility-filter";
import { getCostReport } from "./cost-reports";
import { getCustomGraph, renderOrgCustomGraph } from "./custom-graphs";

type CanvasRow = typeof costCanvases.$inferSelect;

/** A canvas write the caller cannot make: a 400 at the API, a tool error in chat. */
export class CostCanvasInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "CostCanvasInputError";
  }
}

/* ------------------------------------------------------------------ *
 * Rows, placements, conversations
 * ------------------------------------------------------------------ */

async function loadCanvasPlacements(
  organizationId: string,
  canvasIds: string[],
): Promise<Map<string, CostCanvasPlacement[]>> {
  const out = new Map<string, CostCanvasPlacement[]>();
  if (canvasIds.length === 0) return out;
  const rows = await db
    .select({
      widgetId: dashboardWidgets.id,
      dashboardId: dashboardWidgets.dashboardId,
      dashboardName: dashboards.name,
      canvasId: sql<string>`${dashboardWidgets.config} ->> 'canvasId'`,
    })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.kind, "cost_canvas"),
        isNull(dashboardWidgets.deletedAt),
        isNull(dashboards.deletedAt),
        inArray(sql`${dashboardWidgets.config} ->> 'canvasId'`, canvasIds),
      ),
    )
    .orderBy(dashboards.name);
  for (const row of rows) {
    const list = out.get(row.canvasId) ?? [];
    list.push({
      widgetId: row.widgetId,
      dashboardId: row.dashboardId,
      dashboardName: row.dashboardName,
    });
    out.set(row.canvasId, list);
  }
  return out;
}

/** The viewer's latest unarchived conversation per canvas. */
async function loadViewerConversations(
  organizationId: string,
  canvasIds: string[],
  viewerUserId: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!viewerUserId || canvasIds.length === 0) return out;
  const rows = await db
    .select({ id: chatConversations.id, canvasId: chatConversations.costCanvasId })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.organizationId, organizationId),
        eq(chatConversations.userId, viewerUserId),
        isNull(chatConversations.archivedAt),
        inArray(chatConversations.costCanvasId, canvasIds),
      ),
    )
    .orderBy(desc(chatConversations.updatedAt));
  for (const r of rows) {
    if (r.canvasId && !out.has(r.canvasId)) out.set(r.canvasId, r.id);
  }
  return out;
}

function toCostCanvas(
  row: CanvasRow,
  placements: CostCanvasPlacement[],
  conversationId: string | null,
): CostCanvas {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    spec: row.spec as CostCanvasSpec,
    prompt: row.prompt,
    conversationId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    placements,
  };
}

async function hydrate(
  organizationId: string,
  rows: CanvasRow[],
  viewerUserId: string | null,
): Promise<CostCanvas[]> {
  const ids = rows.map((r) => r.id);
  const [placements, conversations] = await Promise.all([
    loadCanvasPlacements(organizationId, ids),
    loadViewerConversations(organizationId, ids, viewerUserId),
  ]);
  return rows.map((r) =>
    toCostCanvas(r, placements.get(r.id) ?? [], conversations.get(r.id) ?? null),
  );
}

async function loadCanvasRowUnchecked(
  organizationId: string,
  canvasId: string,
): Promise<CanvasRow | null> {
  const [row] = await db
    .select()
    .from(costCanvases)
    .where(
      and(
        eq(costCanvases.id, canvasId),
        eq(costCanvases.organizationId, organizationId),
        isNull(costCanvases.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The row when the current sharing principal holds `needed`; null reads as "no such canvas". */
async function loadCanvasRow(
  organizationId: string,
  canvasId: string,
  needed: ObjectAccessLevel | "delete" = "viewer",
): Promise<CanvasRow | null> {
  const row = await loadCanvasRowUnchecked(organizationId, canvasId);
  if (!row) return null;
  try {
    await requireObjectAccess(
      organizationId,
      "cost_canvas",
      row.id,
      { createdByUserId: row.createdByUserId },
      needed,
    );
  } catch (e) {
    if (e instanceof ObjectNotVisibleError) return null;
    throw e;
  }
  return row;
}

/* ------------------------------------------------------------------ *
 * CRUD
 * ------------------------------------------------------------------ */

export async function listCostCanvases(
  organizationId: string,
  viewerUserId: string | null,
): Promise<CostCanvas[]> {
  const allRows = await db
    .select()
    .from(costCanvases)
    .where(and(eq(costCanvases.organizationId, organizationId), isNull(costCanvases.deletedAt)))
    .orderBy(asc(costCanvases.name));
  const rows = await filterVisibleObjects(
    organizationId,
    "cost_canvas",
    allRows,
    (r) => r.id,
    (r) => ({ createdByUserId: r.createdByUserId }),
  );
  return hydrate(organizationId, rows, viewerUserId);
}

export async function getCostCanvas(
  organizationId: string,
  canvasId: string,
  viewerUserId: string | null,
): Promise<CostCanvas | null> {
  const row = await loadCanvasRow(organizationId, canvasId);
  if (!row) return null;
  const [canvas] = await hydrate(organizationId, [row], viewerUserId);
  return canvas ?? null;
}

export async function createCostCanvas(
  organizationId: string,
  input: CostCanvasInput,
  createdByUserId: string | null,
  extra: { prompt?: string | null } = {},
): Promise<CostCanvas> {
  const [created] = await db
    .insert(costCanvases)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      spec: input.spec,
      prompt: extra.prompt ?? null,
      createdByUserId,
    })
    .returning();
  return toCostCanvas(created!, [], null);
}

/** Full replace. Null when not found or not editable by the caller. */
export async function updateCostCanvas(
  organizationId: string,
  canvasId: string,
  input: CostCanvasInput,
  viewerUserId: string | null,
): Promise<CostCanvas | null> {
  if (!(await loadCanvasRow(organizationId, canvasId, "editor"))) return null;
  const [updated] = await db
    .update(costCanvases)
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      spec: input.spec,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(costCanvases.id, canvasId),
        eq(costCanvases.organizationId, organizationId),
        isNull(costCanvases.deletedAt),
      ),
    )
    .returning();
  if (!updated) return null;
  const [canvas] = await hydrate(organizationId, [updated], viewerUserId);
  return canvas ?? null;
}

/** Soft-delete the canvas, its dashboard cards, its schedules and its sharing. */
export async function softDeleteCostCanvas(
  organizationId: string,
  canvasId: string,
): Promise<boolean> {
  if (!(await loadCanvasRow(organizationId, canvasId, "delete"))) return false;
  const now = new Date();
  const [deleted] = await db
    .update(costCanvases)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(costCanvases.id, canvasId),
        eq(costCanvases.organizationId, organizationId),
        isNull(costCanvases.deletedAt),
      ),
    )
    .returning({ id: costCanvases.id });
  if (!deleted) return false;
  await db
    .update(dashboardWidgets)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.kind, "cost_canvas"),
        isNull(dashboardWidgets.deletedAt),
        eq(sql`${dashboardWidgets.config} ->> 'canvasId'`, canvasId),
      ),
    );
  await disableCanvasNotifications(organizationId, canvasId, now);
  await deleteObjectSharing(organizationId, "cost_canvas", canvasId);
  return true;
}

/** Whether the caller can see the canvas at all (for validate-tabs and widget cards). */
export async function costCanvasVisible(
  organizationId: string,
  canvasId: string,
): Promise<{ name: string } | null> {
  const row = await loadCanvasRow(organizationId, canvasId);
  return row ? { name: row.name } : null;
}

/* ------------------------------------------------------------------ *
 * Conversations: the chat agent builds and edits canvases
 * ------------------------------------------------------------------ */

function assertModel(model: string | undefined): string {
  if (model && !CHAT_MODELS.some((m) => m.id === model)) {
    throw new CostCanvasInputError(
      `Unknown model. Supported: ${CHAT_MODELS.map((m) => m.id).join(", ")}`,
    );
  }
  return model ?? DEFAULT_CHAT_MODEL;
}

async function insertCanvasConversation(
  organizationId: string,
  canvas: { id: string; name: string },
  userId: string,
  model: string,
): Promise<string> {
  const id = uuidv4();
  await db.insert(chatConversations).values({
    id,
    organizationId,
    userId,
    title: `Canvas: ${canvas.name}`.slice(0, 200),
    model,
    costCanvasId: canvas.id,
  });
  return id;
}

/**
 * Start a canvas from a description: an empty canvas plus a conversation
 * linked to it. The client sends `prompt` as the conversation's first message
 * (it is stored on the canvas, so a reload can still send it), and the agent
 * writes the spec through `write_cost_canvas`. The first write to an empty
 * canvas applies directly; every later edit is an approval with a diff.
 */
export async function draftCostCanvas(
  organizationId: string,
  input: { prompt: string; name?: string | undefined; model?: string | undefined },
  userId: string,
): Promise<CostCanvas> {
  const model = assertModel(input.model);
  const name = input.name?.trim() || costCanvasNameFromPrompt(input.prompt);
  const canvas = await createCostCanvas(
    organizationId,
    { name, spec: EMPTY_COST_CANVAS_SPEC },
    userId,
    { prompt: input.prompt.trim() },
  );
  const conversationId = await insertCanvasConversation(organizationId, canvas, userId, model);
  return { ...canvas, conversationId };
}

/**
 * Open (or reuse) the caller's conversation for a canvas they can edit: the
 * path for an editor the canvas was shared with, or after the old
 * conversation was archived.
 */
export async function ensureCanvasConversation(
  organizationId: string,
  canvasId: string,
  userId: string,
  opts: { model?: string | undefined; fresh?: boolean | undefined } = {},
): Promise<string> {
  const row = await loadCanvasRow(organizationId, canvasId, "editor");
  if (!row) throw new CostCanvasInputError("Canvas not found", 404);
  if (!opts.fresh) {
    const existing = await loadViewerConversations(organizationId, [canvasId], userId);
    const id = existing.get(canvasId);
    if (id) return id;
  }
  return insertCanvasConversation(organizationId, row, userId, assertModel(opts.model));
}

/**
 * The system-prompt section for a conversation that edits a canvas, or "".
 * Read once per turn; the agent is told to fetch the live spec with
 * `get_cost_canvas` rather than trust this summary, since the user may
 * accept or reject an edit between turns.
 */
export async function canvasAgentContext(conversationId: string): Promise<string> {
  const [conv] = await db
    .select({ canvasId: chatConversations.costCanvasId, orgId: chatConversations.organizationId })
    .from(chatConversations)
    .where(eq(chatConversations.id, conversationId))
    .limit(1);
  if (!conv?.canvasId) return "";
  const row = await loadCanvasRowUnchecked(conv.orgId, conv.canvasId);
  if (!row) return "";
  const spec = row.spec as CostCanvasSpec;
  return `

This conversation builds and edits the cost canvas "${row.name}" (canvasId: ${row.id}, currently ${spec.blocks.length} block${spec.blocks.length === 1 ? "" : "s"}). The user's messages describe the report they want. To build or change it:
- Call \`get_cost_canvas\` first for the current spec; never edit from memory.
- Use the read tools to resolve everything the spec references: \`list_cost_dimension_values\` for provider/account/service/tag values, \`list_business_metrics\` for unit-cost denominators, \`list_budgets\`, \`list_cost_reports\`, \`list_custom_graphs\`, \`list_saved_cost_filters\` where available. Never invent an id.
- Write the whole spec with \`write_cost_canvas\` (canvasId above). It is validated strictly; on an error, fix the reported paths and retry.
- Prefer relative date ranges so the canvas stays current. Put figures in kpi blocks and reference them from text as {{kpiId}} / {{kpiId.change}}; never type a number into text, because text is not re-queried.
- For data from other connected tools, reference an existing custom graph (or write one with \`write_custom_graph\`, which needs its own approval) in a custom_graph block.
- Keep block ids stable when editing so the user's diff shows what really changed. After a write, summarise what the canvas now shows in a sentence or two.
- An edit to a canvas that already has blocks waits for the user's approval with a diff; do not ask for confirmation separately.`;
}

/* ------------------------------------------------------------------ *
 * Diff for approval
 * ------------------------------------------------------------------ */

/** Plain-line diff of a proposed write against the stored canvas. */
export async function describeCanvasWrite(
  organizationId: string,
  canvasId: string,
  next: { name: string; spec: CostCanvasSpec },
): Promise<string | null> {
  const row = await loadCanvasRow(organizationId, canvasId);
  if (!row) return null;
  const changes = diffCostCanvasSpecs(row.spec as CostCanvasSpec, next.spec);
  return describeCostCanvasChanges(changes, { nameBefore: row.name, nameAfter: next.name }).join(
    "\n",
  );
}

/** True when the stored canvas already has content, so a write replaces something. */
export async function canvasHasBlocks(organizationId: string, canvasId: string): Promise<boolean> {
  const row = await loadCanvasRowUnchecked(organizationId, canvasId);
  if (!row) return true;
  return (row.spec as CostCanvasSpec).blocks.length > 0;
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export interface RunCanvasOptions {
  /** Include chart series (CLI, MCP, PDF). The live UI queries charts itself. */
  includeChartData?: boolean | undefined;
  /**
   * The caller's permissions; null is a system caller (delivery). Budgets
   * need `budgets:read` and custom graphs `dashboards:read`, as on their own
   * routes; a block the reader cannot see renders as an error in place.
   */
  granted: readonly string[] | null;
  now?: Date | undefined;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function previousWindow(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days = Math.round((end - start) / 86_400_000) + 1;
  return {
    from: iso(new Date(start - days * 86_400_000)),
    to: iso(new Date(start - 86_400_000)),
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function spendKpi(
  organizationId: string,
  m: Extract<CostCanvasBlock, { kind: "kpi" }>["metric"] & { type: "spend" },
  compare: boolean,
  displayCurrency: string | null,
  now: Date,
): Promise<CostCanvasKpiValue> {
  const { from, to } = resolveCostDateRange(m.dateRange, now);
  const response = await runCostQuery(organizationId, {
    from,
    to,
    binning: "monthly",
    groupBy: "none",
    filters: m.filters,
    ...(m.savedFilterId ? { savedFilterId: m.savedFilterId } : {}),
    topN: 1,
    comparePreviousPeriod: compare,
    forecast: false,
    ...(m.costBasis ? { costBasis: m.costBasis } : {}),
    ...(m.adjusted ? { adjusted: true } : {}),
    ...(displayCurrency ? { displayCurrency } : {}),
  });
  const currency = primaryCostCurrency(response) ?? displayCurrency ?? "USD";
  const value = response.totals[currency] ?? 0;
  const previous = compare ? (response.previousTotals?.[currency] ?? 0) : undefined;
  const others = response.currencies.filter((c) => c !== currency);
  return {
    value,
    unit: "money",
    currency,
    ...(compare ? { previous, changePercent: costCanvasChangePercent(value, previous) } : {}),
    from,
    to,
    ...(others.length > 0 ? { note: `Also spend in ${others.join(", ")}, not included.` } : {}),
  };
}

async function unitCostKpi(
  organizationId: string,
  m: Extract<CostCanvasBlock, { kind: "kpi" }>["metric"] & { type: "unit_cost" },
  compare: boolean,
  displayCurrency: string | null,
  now: Date,
): Promise<CostCanvasKpiValue> {
  const { from, to } = resolveCostDateRange(m.dateRange, now);
  const run = (window: { from: string; to: string }) =>
    runUnitCostQuery(organizationId, m.businessMetricId, {
      ...window,
      binning: "monthly",
      filters: m.filters,
      ...(m.savedFilterId ? { savedFilterId: m.savedFilterId } : {}),
      ...(m.costBasis ? { costBasis: m.costBasis } : {}),
      ...(displayCurrency ? { displayCurrency } : {}),
    });
  const response = await run({ from, to });
  const first = response.series[0];
  let previous: number | null | undefined;
  if (compare) {
    const prev = await run(previousWindow(from, to));
    previous = prev.series.find((s) => s.currency === first?.currency)?.overallValue ?? null;
  }
  const value = first?.overallValue ?? null;
  // Always set on the metric route this KPI calls; null only for the
  // metric-free usage mode, which a KPI never runs.
  const metricName = response.metric?.name ?? m.businessMetricId;
  return {
    value,
    unit: "money_per_unit",
    ...(first ? { currency: first.currency } : {}),
    perUnit: response.metric?.unit || metricName,
    ...(compare ? { previous, changePercent: costCanvasChangePercent(value, previous) } : {}),
    from,
    to,
    ...(value === null ? { note: `No ${metricName} values reported for this window.` } : {}),
    ...(response.series.length > 1
      ? { note: `Spend in ${response.series.length} currencies; showing ${first?.currency}.` }
      : {}),
  };
}

async function forecastKpi(
  organizationId: string,
  m: Extract<CostCanvasBlock, { kind: "kpi" }>["metric"] & { type: "forecast" },
  displayCurrency: string | null,
  now: Date,
): Promise<CostCanvasKpiValue> {
  const { from, to } = resolveCostDateRange({ kind: "relative", preset: "mtd" }, now);
  const monthEnd = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
  const response = await runCostQuery(organizationId, {
    from,
    to,
    binning: "daily",
    groupBy: "none",
    filters: m.filters,
    ...(m.savedFilterId ? { savedFilterId: m.savedFilterId } : {}),
    topN: 1,
    comparePreviousPeriod: false,
    forecast: true,
    ...(displayCurrency ? { displayCurrency } : {}),
  });
  const currency = primaryCostCurrency(response) ?? displayCurrency ?? "USD";
  const actual = response.totals[currency] ?? 0;
  const projected = (response.forecast ?? [])
    .filter((p) => p.bucket > to && p.bucket <= monthEnd)
    .reduce((sum, p) => sum + p.amount, 0);
  return {
    value: actual + projected,
    unit: "money",
    currency,
    from,
    to: monthEnd,
    ...(response.currencies.length > 1
      ? { note: `Projection covers ${currency} spend only.` }
      : {}),
  };
}

async function kpiValue(
  organizationId: string,
  block: Extract<CostCanvasBlock, { kind: "kpi" }>,
  ctx: { displayCurrency: string | null; now: Date; granted: readonly string[] | null },
): Promise<CostCanvasKpiValue> {
  const m = block.metric;
  const compare = block.comparePreviousPeriod === true;
  switch (m.type) {
    case "spend":
      return spendKpi(organizationId, m, compare, ctx.displayCurrency, ctx.now);
    case "unit_cost":
      return unitCostKpi(organizationId, m, compare, ctx.displayCurrency, ctx.now);
    case "forecast":
      return forecastKpi(organizationId, m, ctx.displayCurrency, ctx.now);
    case "budget": {
      requireGranted(ctx.granted, "budgets:read", "budgets");
      const budget = await getBudgetWithStatus(organizationId, m.budgetId);
      if (!budget) throw new Error("This budget was deleted or is not visible to you.");
      return {
        value: budget.amountCents > 0 ? (budget.actualCents / budget.amountCents) * 100 : null,
        unit: "percent",
        note: `${budget.name}, ${budget.month}`,
      };
    }
    case "anomaly_count": {
      if (withholdOrgWideFindings(organizationId)) {
        return {
          value: null,
          unit: "count",
          note: "Anomalies are detected over all of the org's spend and are not shown to scoped viewers.",
        };
      }
      const rows = await listRecentCostAnomalies(organizationId, m.days);
      return {
        value: rows.length,
        unit: "count",
        from: iso(new Date(ctx.now.getTime() - m.days * 86_400_000)),
        to: iso(ctx.now),
      };
    }
  }
}

function requireGranted(granted: readonly string[] | null, permission: string, what: string): void {
  if (granted !== null && !hasPermission(granted, permission)) {
    throw new Error(`Your role cannot see ${what} (${permission}).`);
  }
}

async function chartData(
  organizationId: string,
  config: CostGraphConfig,
  displayCurrency: string | null,
  now: Date,
): Promise<
  Pick<Extract<CostCanvasBlockResult, { kind: "chart" }>, "from" | "to" | "cost" | "unitCost">
> {
  if (isUnitCostConfig(config)) {
    const request = {
      ...unitCostQueryForConfig(config, now),
      ...(displayCurrency ? { displayCurrency } : {}),
    };
    // Cost per usage unit has no metric behind it: the same split the
    // dashboard PDF and the cards make.
    const unitCost =
      config.unitCostMode === "usage_unit_cost"
        ? await runUsageUnitCostQuery(organizationId, request)
        : await runUnitCostQuery(organizationId, config.unitCostMetricId!, request);
    return { from: request.from, to: request.to, unitCost };
  }
  const request = costQueryForConfig(config, now);
  const cost = await runCostQuery(organizationId, {
    ...request,
    ...(displayCurrency ? { displayCurrency } : {}),
  });
  return { from: request.from, to: request.to, cost };
}

async function runBlock(
  organizationId: string,
  block: Exclude<CostCanvasBlock, { kind: "text" | "kpi" }>,
  ctx: {
    displayCurrency: string | null;
    now: Date;
    granted: readonly string[] | null;
    includeChartData: boolean;
  },
): Promise<CostCanvasBlockResult> {
  switch (block.kind) {
    case "chart": {
      if (!ctx.includeChartData) {
        const window = resolveCostDateRange(block.config.dateRange, ctx.now);
        return { id: block.id, kind: "chart", ...window };
      }
      return {
        id: block.id,
        kind: "chart",
        ...(await chartData(organizationId, block.config, ctx.displayCurrency, ctx.now)),
      };
    }
    case "table": {
      const q = block.query;
      const window = resolveCostDateRange(q.dateRange, ctx.now);
      const response = await runCostQuery(organizationId, {
        ...window,
        binning: q.binning === "none" ? "monthly" : q.binning,
        groupBy: q.groupBy,
        ...(q.groupByTagKey ? { groupByTagKey: q.groupByTagKey } : {}),
        filters: q.filters,
        ...(q.savedFilterId ? { savedFilterId: q.savedFilterId } : {}),
        topN: q.topN,
        comparePreviousPeriod: false,
        forecast: false,
        ...(q.costBasis ? { costBasis: q.costBasis } : {}),
        ...(q.adjusted ? { adjusted: true } : {}),
        ...(ctx.displayCurrency ? { displayCurrency: ctx.displayCurrency } : {}),
      });
      return {
        id: block.id,
        kind: "table",
        table: costCanvasTableFromResponse(response, q.binning, window),
      };
    }
    case "budgets": {
      requireGranted(ctx.granted, "budgets:read", "budgets");
      const all = await listBudgetsWithStatus(organizationId);
      const wanted = block.budgetIds && block.budgetIds.length > 0 ? block.budgetIds : null;
      const budgets = wanted ? all.filter((b) => wanted.includes(b.id)) : all;
      const found = new Set(budgets.map((b) => b.id));
      return {
        id: block.id,
        kind: "budgets",
        budgets,
        missing: wanted ? wanted.filter((id) => !found.has(id)) : [],
      };
    }
    case "anomalies": {
      const withheld = withholdOrgWideFindings(organizationId);
      const anomalies = withheld
        ? []
        : (await listRecentCostAnomalies(organizationId, block.days)).slice(0, block.limit);
      return { id: block.id, kind: "anomalies", anomalies, withheld };
    }
    case "cost_report": {
      const report = await getCostReport(organizationId, block.reportId);
      if (!report) {
        return {
          id: block.id,
          kind: "cost_report",
          report: null,
          error: "This saved report was deleted or is not shared with you.",
        };
      }
      const base = {
        id: block.id,
        kind: "cost_report" as const,
        report: {
          id: report.id,
          name: report.name,
          description: report.description,
          config: report.config,
        },
      };
      if (!ctx.includeChartData) {
        return { ...base, ...resolveCostDateRange(report.config.dateRange, ctx.now) };
      }
      return {
        ...base,
        ...(await chartData(organizationId, report.config, ctx.displayCurrency, ctx.now)),
      };
    }
    case "custom_graph": {
      requireGranted(ctx.granted, "dashboards:read", "custom graphs");
      const graph = await getCustomGraph(organizationId, block.graphId);
      if (!graph) {
        return {
          id: block.id,
          kind: "custom_graph",
          graph: null,
          spec: null,
          error: "This custom graph was deleted.",
        };
      }
      const result = await renderOrgCustomGraph(organizationId, graph.id, { trigger: "manual" });
      return {
        id: block.id,
        kind: "custom_graph",
        graph: { id: graph.id, name: graph.name },
        spec: result.ok ? result.spec : null,
        ...(result.ok
          ? {}
          : { error: `The graph's script failed: ${result.error ?? "no output"}` }),
      };
    }
  }
}

function failed(block: CostCanvasBlock, message: string): CostCanvasBlockResult {
  switch (block.kind) {
    case "text":
      return { id: block.id, kind: "text", text: "", error: message };
    case "kpi":
      return { id: block.id, kind: "kpi", kpi: null, error: message };
    case "chart":
      return { id: block.id, kind: "chart", from: "", to: "", error: message };
    case "table":
      return { id: block.id, kind: "table", table: null, error: message };
    case "budgets":
      return { id: block.id, kind: "budgets", budgets: [], missing: [], error: message };
    case "anomalies":
      return { id: block.id, kind: "anomalies", anomalies: [], withheld: false, error: message };
    case "cost_report":
      return { id: block.id, kind: "cost_report", report: null, error: message };
    case "custom_graph":
      return { id: block.id, kind: "custom_graph", graph: null, spec: null, error: message };
  }
}

async function displayCurrencyOf(organizationId: string): Promise<string | null> {
  return getOrgCurrencySettings(organizationId)
    .then((s) => s.displayCurrency)
    .catch(() => null);
}

/**
 * Execute a spec: every block re-queried, nothing cached. A failing block
 * renders its error in place rather than failing the canvas, the dashboard
 * PDF's rule.
 */
export async function runCostCanvasSpec(
  organizationId: string,
  canvas: { id: string | null; name: string; spec: CostCanvasSpec },
  opts: RunCanvasOptions,
): Promise<CostCanvasRunResult> {
  const now = opts.now ?? new Date();
  const displayCurrency = await displayCurrencyOf(organizationId);
  const ctx = {
    displayCurrency,
    now,
    granted: opts.granted,
    includeChartData: opts.includeChartData !== false,
  };

  const kpis = new Map<string, CostCanvasKpiValue | null>();
  const results = await Promise.all(
    canvas.spec.blocks.map(async (block): Promise<CostCanvasBlockResult | null> => {
      if (block.kind === "text") return null;
      try {
        if (block.kind === "kpi") {
          const kpi = await kpiValue(organizationId, block, ctx);
          kpis.set(block.id, kpi);
          return { id: block.id, kind: "kpi", kpi };
        }
        return await runBlock(organizationId, block, ctx);
      } catch (e) {
        if (block.kind === "kpi") kpis.set(block.id, null);
        return failed(block, errorMessage(e));
      }
    }),
  );

  const blocks = canvas.spec.blocks.map((block, i): CostCanvasBlockResult =>
    block.kind === "text"
      ? { id: block.id, kind: "text", text: renderCostCanvasText(block.text, kpis) }
      : results[i]!,
  );
  return {
    canvasId: canvas.id,
    name: canvas.name,
    ranAt: now.toISOString(),
    displayCurrency,
    blocks,
  };
}

/** Run a saved canvas by id. Null when not found (or not shared with the caller). */
export async function runCostCanvas(
  organizationId: string,
  canvasId: string,
  opts: RunCanvasOptions,
): Promise<CostCanvasRunResult | null> {
  const row = await loadCanvasRow(organizationId, canvasId);
  if (!row) return null;
  return runCostCanvasSpec(
    organizationId,
    { id: row.id, name: row.name, spec: row.spec as CostCanvasSpec },
    opts,
  );
}
