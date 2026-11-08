/**
 * Dashboards: the database work behind `/api/org/:orgId/dashboards` (the
 * dashboards, their cards, resource and workflow pins, cached probe data), as
 * the Hono router did it, query for query. Widgets are `./widgets.ts` and the
 * restored-tab check `./tabs.ts`. Promise code: the handlers in
 * `./index.ts` call it through `legacy`/`refusalCall`, inside the request's
 * scopes (object sharing reads the caller's sharing principal from them).
 *
 * A route's own refusal ("Dashboard not found", "Cannot delete the default
 * dashboard") is thrown as a {@link DashboardRefusal} at the point the route
 * returned it, so each check keeps its place between the reads around it.
 * Sharing refusals (`requireObjectAccess`) are thrown by the sharing service
 * and rendered by the API's error renderer, as before.
 */
import { and, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { Predicate } from "effect";
import { v4 as uuidv4 } from "uuid";
import { showcaseFields, type ProbeStatus } from "@infrawrench/plugin-base";
import { DASHBOARD_WIDGET_KINDS, type DashboardWidgetKind } from "@infrawrench/client-core";
import {
  getLatestAccountCountsBatch,
  getLatestMetrics,
  getLatestMetricsBatch,
  getLatestStats,
  getLatestStatsBatch,
  getMetricRange,
} from "@infrawrench/server-core/clickhouse/readers";
import { db } from "../../../db/client";
import {
  accounts,
  costCanvases,
  costReports,
  dashboardPins,
  dashboardWidgets,
  dashboardWorkflowPins,
  dashboards,
  resources,
  workflowMetrics,
  workflowRuns,
  workflows,
} from "../../../db/schema";
import { getPlugin } from "../../../plugins/loader";
import {
  deleteObjectSharing,
  filterVisibleObjects,
  grantCreatorOwnership,
  loadObjectMeta,
  requireObjectAccess,
} from "../../../services/object-sharing";
import { resolveDefaultDashboard } from "../../../services/default-dashboards";
import { nextPinSyncVersion } from "../../../services/sync-versions";

/** A refusal the route answered itself, with its status and sentence. */
export class DashboardRefusal extends Error {
  override readonly name = "DashboardRefusal";
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

/** A property of a parsed JSON value, or undefined when it is not an object. */
export const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined;

/** The string at `key`, or undefined: an id of any other type matches no row. */
export const stringField = (value: unknown, key: string): string | undefined => {
  const v = field(value, key);
  return Predicate.isString(v) ? v : undefined;
};

export const isWidgetKind = (value: unknown): value is DashboardWidgetKind =>
  DASHBOARD_WIDGET_KINDS.some((kind) => kind === value);

/** Card kinds the grid can hold, and therefore that a reorder may name. */
const CARD_KINDS = ["resource", "workflow", "widget"] as const;
type CardKind = (typeof CARD_KINDS)[number];
const isCardKind = (value: unknown): value is CardKind => CARD_KINDS.some((k) => k === value);

/**
 * Next free slot at the end of a dashboard's grid.
 *
 * Resource pins, workflow pins, and widgets share one drag-reorderable
 * sequence, so a new card of any kind has to clear the highest `gridX` across
 * all three tables: placing it at the end of its own table would drop it into
 * the middle of the grid.
 */
export async function nextGridX(dashboardId: string): Promise<number> {
  const [pins, workflowPins, widgets] = await Promise.all([
    db
      .select({ value: max(dashboardPins.gridX) })
      .from(dashboardPins)
      .where(eq(dashboardPins.dashboardId, dashboardId)),
    db
      .select({ value: max(dashboardWorkflowPins.gridX) })
      .from(dashboardWorkflowPins)
      .where(eq(dashboardWorkflowPins.dashboardId, dashboardId)),
    db
      .select({ value: max(dashboardWidgets.gridX) })
      .from(dashboardWidgets)
      .where(
        and(eq(dashboardWidgets.dashboardId, dashboardId), isNull(dashboardWidgets.deletedAt)),
      ),
  ]);
  const highest = Math.max(
    pins[0]?.value ?? -1,
    workflowPins[0]?.value ?? -1,
    widgets[0]?.value ?? -1,
  );
  return highest + 1;
}

interface WorkflowPinDto {
  pinId: string;
  workflowId: string;
  gridX: number;
  name: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  metrics: Array<{ key: unknown; label: unknown; unit: unknown; value: unknown }>;
}

/**
 * Load the workflow pins for a dashboard, enriched with each workflow's
 * declared metrics (current values), last-run time, and last-run status. All
 * data is DB-only (no plugin probing), so it's returned inline with the
 * dashboard rather than via a separate enrich endpoint like resource pins.
 */
async function loadWorkflowPins(dashboardId: string): Promise<WorkflowPinDto[]> {
  const pins = await db
    .select({
      pinId: dashboardWorkflowPins.id,
      workflowId: dashboardWorkflowPins.workflowId,
      gridX: dashboardWorkflowPins.gridX,
      name: workflows.name,
      lastRunAt: workflows.lastRunAt,
      metricDefs: workflows.metricDefs,
    })
    .from(dashboardWorkflowPins)
    .innerJoin(workflows, eq(dashboardWorkflowPins.workflowId, workflows.id))
    .where(
      and(
        eq(dashboardWorkflowPins.dashboardId, dashboardId),
        isNull(dashboardWorkflowPins.deletedAt),
        isNull(workflows.deletedAt),
      ),
    )
    .orderBy(dashboardWorkflowPins.gridX, dashboardWorkflowPins.createdAt);

  if (pins.length === 0) return [];

  const workflowIds = pins.map((p) => p.workflowId);

  const metricRows = await db
    .select({
      workflowId: workflowMetrics.workflowId,
      key: workflowMetrics.key,
      value: workflowMetrics.value,
    })
    .from(workflowMetrics)
    .where(
      and(inArray(workflowMetrics.workflowId, workflowIds), isNull(workflowMetrics.deletedAt)),
    );
  const valueByKey = new Map<string, unknown>();
  for (const m of metricRows) valueByKey.set(`${m.workflowId}:${m.key}`, m.value ?? null);

  const runRows = await db
    .select({ workflowId: workflowRuns.workflowId, status: workflowRuns.status })
    .from(workflowRuns)
    .where(inArray(workflowRuns.workflowId, workflowIds))
    .orderBy(desc(workflowRuns.createdAt));
  const latestStatus = new Map<string, string>();
  for (const r of runRows)
    if (!latestStatus.has(r.workflowId)) latestStatus.set(r.workflowId, r.status);

  return pins.map((p) => {
    // The stored definitions (`StoredWorkflowMetricDef[]`), read as stored.
    const defs: unknown[] = Array.isArray(p.metricDefs) ? p.metricDefs : [];
    return {
      pinId: p.pinId,
      workflowId: p.workflowId,
      gridX: p.gridX,
      name: p.name,
      lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
      lastStatus: latestStatus.get(p.workflowId) ?? null,
      metrics: defs.map((d) => {
        const key = field(d, "key");
        return {
          key,
          label: field(d, "label") ?? key,
          unit: field(d, "unit") ?? null,
          value: valueByKey.get(`${p.workflowId}:${String(key)}`) ?? null,
        };
      }),
    };
  });
}

interface WidgetDto {
  id: string;
  dashboardId: string;
  kind: string;
  title: string;
  config: unknown;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}

/** Load the non-resource widgets (cost graphs, budgets) for a dashboard. */
async function loadWidgets(dashboardId: string): Promise<WidgetDto[]> {
  const rows = await db
    .select()
    .from(dashboardWidgets)
    .where(and(eq(dashboardWidgets.dashboardId, dashboardId), isNull(dashboardWidgets.deletedAt)))
    .orderBy(dashboardWidgets.gridX, dashboardWidgets.createdAt);
  return rows.map((w) => ({
    id: w.id,
    dashboardId: w.dashboardId,
    kind: w.kind,
    title: w.title,
    config: w.config,
    gridX: w.gridX,
    gridY: w.gridY,
    gridW: w.gridW,
    gridH: w.gridH,
  }));
}

/**
 * Drop report and canvas cards whose object the caller cannot open: the card would
 * otherwise render the report's figures on a dashboard they *can* open.
 */
async function visibleWidgets(organizationId: string, input: WidgetDto[]): Promise<WidgetDto[]> {
  let widgets = input;
  const canvasIds = widgets
    .filter((w) => w.kind === "cost_canvas")
    .map((w) => field(w.config, "canvasId"))
    .filter(Predicate.isString);
  if (canvasIds.length > 0) {
    const canvasRows = await db
      .select({ id: costCanvases.id, createdByUserId: costCanvases.createdByUserId })
      .from(costCanvases)
      .where(
        and(eq(costCanvases.organizationId, organizationId), inArray(costCanvases.id, canvasIds)),
      );
    const visibleCanvases = new Set(
      (
        await filterVisibleObjects(
          organizationId,
          "cost_canvas",
          canvasRows,
          (r) => r.id,
          (r) => r,
        )
      ).map((r) => r.id),
    );
    widgets = widgets.filter(
      (w) =>
        w.kind !== "cost_canvas" || visibleCanvases.has(stringField(w.config, "canvasId") ?? ""),
    );
  }
  const reportIds = widgets
    .filter((w) => w.kind === "cost_report")
    .map((w) => field(w.config, "reportId"))
    .filter(Predicate.isString);
  if (reportIds.length === 0) return widgets;
  const rows = await db
    .select({
      id: costReports.id,
      createdByUserId: costReports.createdByUserId,
      folderId: costReports.folderId,
    })
    .from(costReports)
    .where(and(eq(costReports.organizationId, organizationId), inArray(costReports.id, reportIds)));
  const visible = new Set(
    (
      await filterVisibleObjects(
        organizationId,
        "cost_report",
        rows,
        (r) => r.id,
        (r) => r,
      )
    ).map((r) => r.id),
  );
  return widgets.filter(
    (w) => w.kind !== "cost_report" || visible.has(stringField(w.config, "reportId") ?? ""),
  );
}

// --- Dashboards ------------------------------------------------------------

/** Every dashboard the caller's sharing lets them open, marking the one they land on. */
export async function listDashboards(organizationId: string, userId: string) {
  // Which one the caller lands on, so the sidebars can mark it and link it
  // home. Resolved first: it creates the org default on a brand-new org, and
  // the list below should then include it.
  const resolved = await resolveDefaultDashboard(organizationId, userId);
  const rows = await db
    .select({ id: dashboards.id, name: dashboards.name, isDefault: dashboards.isDefault })
    .from(dashboards)
    .where(and(eq(dashboards.organizationId, organizationId), isNull(dashboards.deletedAt)))
    .orderBy(desc(dashboards.isDefault), dashboards.createdAt);
  // Only the dashboards the caller's sharing lets them open.
  const visible = await filterVisibleObjects(organizationId, "dashboard", rows, (d) => d.id);
  return visible.map((d) => ({ ...d, isResolvedDefault: d.id === resolved.dashboardId }));
}

export async function createDashboard(organizationId: string, name: string, userId: string) {
  const [created] = await db
    .insert(dashboards)
    .values({ id: uuidv4(), organizationId, name, isDefault: false })
    .returning();
  if (!created) throw new Error("Dashboard insert returned no row");
  await grantCreatorOwnership(organizationId, "dashboard", created.id, userId);
  return created;
}

/** A dashboard's cards: resource pins, workflow pins, and the widgets the caller may see. */
async function loadCards(organizationId: string, dashboardId: string) {
  const pins = await db
    .select({
      pinId: dashboardPins.id,
      resourceId: dashboardPins.resourceId,
      gridX: dashboardPins.gridX,
      gridY: dashboardPins.gridY,
      gridW: dashboardPins.gridW,
      gridH: dashboardPins.gridH,
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .where(
      and(
        eq(dashboardPins.dashboardId, dashboardId),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    )
    .orderBy(dashboardPins.gridX, dashboardPins.createdAt);

  const workflowPins = await loadWorkflowPins(dashboardId);
  const widgets = await visibleWidgets(organizationId, await loadWidgets(dashboardId));
  return { pins, workflowPins, widgets };
}

/** GET /:id: the dashboard with its pins, for a caller who can view it. */
export async function getDashboardWithPins(organizationId: string, dashboardId: string) {
  const [dashboard] = await db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);

  if (!dashboard) throw new DashboardRefusal(404, "Not found");
  await requireObjectAccess(organizationId, "dashboard", dashboard.id, {}, "viewer");

  const { pins, workflowPins, widgets } = await loadCards(organizationId, dashboardId);
  return { dashboard, pins, workflowPins, widgets };
}

/**
 * GET /default/full: the caller's default dashboard (user, then role, then
 * org; the org default is created on first read) with its pins.
 * `resolution` says which layer it came from.
 */
export async function getDefaultDashboardFull(organizationId: string, userId: string) {
  const resolution = await resolveDefaultDashboard(organizationId, userId);
  const [defaultDashboard] = await db
    .select()
    .from(dashboards)
    .where(
      and(eq(dashboards.organizationId, organizationId), eq(dashboards.id, resolution.dashboardId)),
    )
    .limit(1);
  if (!defaultDashboard) throw new DashboardRefusal(404, "Not found");
  await requireObjectAccess(organizationId, "dashboard", defaultDashboard.id, {}, "viewer");

  const { pins, workflowPins, widgets } = await loadCards(organizationId, defaultDashboard.id);
  return { dashboard: defaultDashboard, pins, workflowPins, widgets, resolution };
}

export async function renameDashboard(organizationId: string, dashboardId: string, name: string) {
  if (!(await loadObjectMeta(organizationId, "dashboard", dashboardId))) {
    throw new DashboardRefusal(404, "Not found");
  }
  await requireObjectAccess(organizationId, "dashboard", dashboardId, {}, "editor");
  await db
    .update(dashboards)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)));
}

export async function deleteDashboard(organizationId: string, dashboardId: string) {
  const [dash] = await db
    .select({ isDefault: dashboards.isDefault })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);

  if (!dash) throw new DashboardRefusal(404, "Not found");
  if (dash.isDefault) throw new DashboardRefusal(400, "Cannot delete the default dashboard");
  await requireObjectAccess(organizationId, "dashboard", dashboardId, {}, "delete");
  await deleteObjectSharing(organizationId, "dashboard", dashboardId);

  await db.delete(dashboardPins).where(eq(dashboardPins.dashboardId, dashboardId));
  await db
    .delete(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)));
}

/**
 * The dashboard, when it is in the org and the caller may change what it
 * shows (`editor` through sharing); "Dashboard not found" otherwise. A
 * missing or non-string id matches no row, as the route's query did.
 */
async function editableDashboard(organizationId: string, dashboardId: string | undefined) {
  if (dashboardId === undefined) throw new DashboardRefusal(404, "Dashboard not found");
  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) throw new DashboardRefusal(404, "Dashboard not found");
  // Sharing: changing what a dashboard shows needs editor on it.
  await requireObjectAccess(organizationId, "dashboard", dashboard.id, {}, "editor");
  return dashboard;
}

/**
 * POST /:id/reorder: persist card order.
 *
 * `cards` is the whole grid in its new order, mixing all three kinds, and
 * `gridX` is written as the index within that one sequence. `resourceIds` is
 * the older resource-pins-only form, kept for compatibility and treated as
 * `cards` of kind "resource".
 */
export async function reorderCards(organizationId: string, dashboardId: string, body: unknown) {
  const listed = field(body, "cards") ?? field(body, "resourceIds") ?? [];
  const fromResourceIds = (field(body, "cards") ?? undefined) === undefined;
  const cards: Array<{ kind: CardKind; id: string }> = [];
  if (!Array.isArray(listed)) throw new DashboardRefusal(400, "Invalid card reference");
  for (const entry of listed) {
    const kind = fromResourceIds ? "resource" : field(entry, "kind");
    const id = fromResourceIds ? entry : field(entry, "id");
    if (!isCardKind(kind) || !Predicate.isString(id) || !id) {
      throw new DashboardRefusal(400, "Invalid card reference");
    }
    cards.push({ kind, id });
  }

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) throw new DashboardRefusal(404, "Dashboard not found");
  // Sharing: changing what a dashboard shows needs editor on it.
  await requireObjectAccess(organizationId, "dashboard", dashboard.id, {}, "editor");

  await Promise.all(
    cards.map(({ kind, id }, index) => {
      if (kind === "workflow") {
        return db
          .update(dashboardWorkflowPins)
          .set({ gridX: index })
          .where(
            and(
              eq(dashboardWorkflowPins.dashboardId, dashboardId),
              eq(dashboardWorkflowPins.workflowId, id),
            ),
          );
      }
      if (kind === "widget") {
        return db
          .update(dashboardWidgets)
          .set({ gridX: index })
          .where(and(eq(dashboardWidgets.dashboardId, dashboardId), eq(dashboardWidgets.id, id)));
      }
      return db
        .update(dashboardPins)
        .set({ gridX: index, syncVersion: nextPinSyncVersion(organizationId) })
        .where(and(eq(dashboardPins.dashboardId, dashboardId), eq(dashboardPins.resourceId, id)));
    }),
  );
}

// --- Pins ------------------------------------------------------------------

export async function pinResource(organizationId: string, body: unknown) {
  const dashboardId = stringField(body, "dashboardId");
  const resourceId = stringField(body, "resourceId");
  const gridX = field(body, "gridX");
  const gridY = field(body, "gridY");
  const dashboard = await editableDashboard(organizationId, dashboardId);

  const [resource] =
    resourceId === undefined
      ? []
      : await db
          .select({ id: resources.id })
          .from(resources)
          .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
          .limit(1);
  if (!resource) throw new DashboardRefusal(404, "Resource not found");

  // When no explicit position, place at the end of the whole grid
  const effectiveGridX = Predicate.isNumber(gridX) ? gridX : await nextGridX(dashboard.id);

  await db
    .insert(dashboardPins)
    .values({
      id: uuidv4(),
      dashboardId: dashboard.id,
      resourceId: resource.id,
      gridX: effectiveGridX,
      gridY: Predicate.isNumber(gridY) ? gridY : 0,
      syncVersion: nextPinSyncVersion(organizationId),
    })
    // A conflict means the resource is already pinned here: unpin hard-deletes,
    // so no tombstone can be in the way. Leave the existing card's position
    // alone rather than yanking it back to the end of the row.
    .onConflictDoNothing();
}

export async function unpinResource(organizationId: string, body: unknown) {
  const dashboard = await editableDashboard(organizationId, stringField(body, "dashboardId"));
  const resourceId = stringField(body, "resourceId");

  // Hard delete. A tombstone would be what tells a pulling client the pin went
  // away, but desktop sync is push-only (see electron/cloud-sync.ts) so nothing
  // consumes one: it would just accumulate rows. Revisit alongside any future
  // downward apply: deletions are invisible to a puller without it.
  if (resourceId === undefined) return;
  await db
    .delete(dashboardPins)
    .where(
      and(eq(dashboardPins.dashboardId, dashboard.id), eq(dashboardPins.resourceId, resourceId)),
    );
}

/** POST /workflow-pin: pin a workflow's metrics onto a dashboard. */
export async function pinWorkflow(organizationId: string, body: unknown) {
  const dashboard = await editableDashboard(organizationId, stringField(body, "dashboardId"));
  const workflowId = stringField(body, "workflowId");

  const [workflow] =
    workflowId === undefined
      ? []
      : await db
          .select({ id: workflows.id })
          .from(workflows)
          .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, organizationId)))
          .limit(1);
  if (!workflow) throw new DashboardRefusal(404, "Workflow not found");

  await db
    .insert(dashboardWorkflowPins)
    .values({
      id: uuidv4(),
      organizationId,
      dashboardId: dashboard.id,
      workflowId: workflow.id,
      gridX: await nextGridX(dashboard.id),
    })
    .onConflictDoNothing();
}

/** POST /workflow-unpin: remove a pinned workflow. */
export async function unpinWorkflow(organizationId: string, body: unknown) {
  const dashboard = await editableDashboard(organizationId, stringField(body, "dashboardId"));
  const workflowId = stringField(body, "workflowId");

  if (workflowId === undefined) return;
  await db
    .delete(dashboardWorkflowPins)
    .where(
      and(
        eq(dashboardWorkflowPins.dashboardId, dashboard.id),
        eq(dashboardWorkflowPins.workflowId, workflowId),
      ),
    );
}

/**
 * Build the ProbeStatus dashboard cards consume, from data already fetched
 * out of ClickHouse. Sparkline = first MetricSeries with ≥2 points.
 */
function projectProbeStatus(row: {
  resourceTypeId: string;
  latestStats: Awaited<ReturnType<typeof getLatestStats>>;
  latestMetrics: Awaited<ReturnType<typeof getLatestMetrics>>;
  accountCounts: { typeLabel: string; count: number }[] | null;
}): ProbeStatus {
  if (row.resourceTypeId === "__account__") {
    return { phase: "ok", resourceCounts: row.accountCounts ?? [] };
  }
  const result: ProbeStatus = { phase: "ok" };
  if (row.latestStats) result.stats = row.latestStats;
  const firstSeries = row.latestMetrics?.[0];
  if (firstSeries && firstSeries.points.length >= 2) {
    result.sparkline = firstSeries.points;
    result.sparklineLabel = firstSeries.label;
  }
  return result;
}

/** GET /pin/:pinId: full enriched pin data + probed status. */
export async function getPinFull(organizationId: string, pinId: string) {
  const [pin] = await db
    .select({
      pinId: dashboardPins.id,
      resourceId: dashboardPins.resourceId,
      gridX: dashboardPins.gridX,
      gridY: dashboardPins.gridY,
      gridW: dashboardPins.gridW,
      gridH: dashboardPins.gridH,
      displayName: resources.displayName,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      dashboardOrgId: dashboards.organizationId,
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .innerJoin(dashboards, eq(dashboardPins.dashboardId, dashboards.id))
    .innerJoin(accounts, eq(resources.accountId, accounts.id))
    .where(
      and(
        eq(dashboardPins.id, pinId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);

  if (!pin) throw new DashboardRefusal(404, "Pin not found");

  const loaded = await getPlugin(pin.pluginId);
  const pluginLogoSvg = loaded?.plugin.manifest.logoSvg ?? "";
  const pluginDisplayName = loaded?.plugin.manifest.displayName ?? pin.pluginId;
  const pinType = loaded?.plugin.resourceTypes.find((t) => t.id === pin.resourceTypeId);
  const iconKey = pinType?.iconKey;
  const showcase = pinType ? showcaseFields(pinType) : [];

  const [latestStats, latestMetrics, accountCounts] = await Promise.all([
    pin.resourceTypeId === "__account__"
      ? Promise.resolve(null)
      : getLatestStats(organizationId, pin.resourceId),
    pin.resourceTypeId === "__account__"
      ? Promise.resolve(null)
      : getLatestMetrics(organizationId, pin.resourceId),
    pin.resourceTypeId === "__account__"
      ? ((await getLatestAccountCountsBatch(organizationId, [pin.accountId])).get(pin.accountId) ??
        null)
      : Promise.resolve(null),
  ]);

  const status = projectProbeStatus({
    resourceTypeId: pin.resourceTypeId,
    latestStats,
    latestMetrics,
    accountCounts,
  });

  const { dashboardOrgId: _omit, ...pinFields } = pin;
  return {
    ...pinFields,
    pluginLogoSvg,
    pluginDisplayName,
    ...(iconKey ? { iconKey } : {}),
    showcase,
    status,
  };
}

/** GET /pin/:pinId/range?fromMs=…&toMs=…: historical metric series. */
export async function getPinRange(
  organizationId: string,
  pinId: string,
  fromParam: string | undefined,
  toParam: string | undefined,
) {
  const fromMs = Number(fromParam);
  const toMs = Number(toParam);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new DashboardRefusal(400, "Invalid fromMs/toMs");
  }

  const [pin] = await db
    .select({
      resourceId: dashboardPins.resourceId,
      resourceTypeId: resources.resourceTypeId,
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .innerJoin(dashboards, eq(dashboardPins.dashboardId, dashboards.id))
    .where(
      and(
        eq(dashboardPins.id, pinId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);
  if (!pin) throw new DashboardRefusal(404, "Pin not found");
  if (pin.resourceTypeId === "__account__") return { series: [] };

  const series = await getMetricRange(organizationId, pin.resourceId, fromMs, toMs);
  return { series };
}

/** POST /probe: read cached stats/metrics for dashboard cards. */
export async function probeCards(
  organizationId: string,
  items: ReadonlyArray<{ readonly resourceId: string }>,
) {
  const results: Record<string, ProbeStatus> = {};
  if (items.length === 0) return results;

  const rows = await db
    .select({
      resourceId: resources.id,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
    })
    .from(resources)
    .innerJoin(accounts, eq(resources.accountId, accounts.id))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        inArray(
          resources.id,
          items.map((i) => i.resourceId),
        ),
      ),
    );

  const byId = new Map(rows.map((r) => [r.resourceId, r]));

  const resourceIdsForMetrics = rows.flatMap((r) =>
    r.resourceTypeId !== "__account__" ? [r.resourceId] : [],
  );
  const accountIdsForCounts = [
    ...new Set(rows.flatMap((r) => (r.resourceTypeId === "__account__" ? [r.accountId] : []))),
  ];

  const [statsByResource, metricsByResource, countsByAccount] = await Promise.all([
    getLatestStatsBatch(organizationId, resourceIdsForMetrics),
    getLatestMetricsBatch(organizationId, resourceIdsForMetrics),
    getLatestAccountCountsBatch(organizationId, accountIdsForCounts),
  ]);

  for (const item of items) {
    const row = byId.get(item.resourceId);
    if (!row) {
      results[item.resourceId] = { phase: "error", error: "Resource not found" };
      continue;
    }
    results[item.resourceId] = projectProbeStatus({
      resourceTypeId: row.resourceTypeId,
      latestStats: statsByResource.get(row.resourceId) ?? null,
      latestMetrics: metricsByResource.get(row.resourceId) ?? null,
      accountCounts: countsByAccount.get(row.accountId) ?? null,
    });
  }

  return results;
}
