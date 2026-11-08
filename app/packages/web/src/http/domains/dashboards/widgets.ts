/**
 * Dashboards: the non-resource cards (cost graphs, reports, budgets, KPIs,
 * text) behind `/dashboards/widgets…`, as the Hono router wrote them. Promise
 * code, called through `refusalCall`.
 *
 * A config is decoded against its kind's schema (`WIDGET_CONFIG_SCHEMAS` in
 * `@infrawrench/api-contract/schemas`, the editors' own) and stored as decoded. A card
 * pointing at a report or canvas may only be placed by a caller who can open
 * that object: the card would otherwise show its figures.
 */
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { Predicate, Result, Schema, SchemaIssue } from "effect";
import { v4 as uuidv4 } from "uuid";
import {
  DASHBOARD_GRID_LIMITS,
  defaultWidgetSize,
  duplicateCostReportName,
  type DashboardWidgetKind,
} from "@infrawrench/client-core";
import { WIDGET_CONFIG_SCHEMAS } from "@infrawrench/api-contract/schemas";
import { db } from "../../../db/client";
import {
  dashboardPins,
  dashboardWidgets,
  dashboardWorkflowPins,
  dashboards,
} from "../../../db/schema";
import { loadObjectMeta, requireObjectAccess } from "../../../services/object-sharing";
import { nextPinSyncVersion } from "../../../services/sync-versions";
import { HttpFailure } from "../../errors";
import { DashboardRefusal, field, isWidgetKind, nextGridX } from "./store";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * A widget config decoded against its kind's schema: the stored value (the
 * schema's output, unknown keys dropped, as zod's `safeParse` gave), or the
 * route's `{ error: "Invalid widget config", issues }` 400.
 */
function decodeWidgetConfig(kind: DashboardWidgetKind, config: unknown): unknown {
  const schema: Schema.Decoder<unknown> = WIDGET_CONFIG_SCHEMAS[kind];
  const result = Schema.decodeUnknownResult(schema)(config, { errors: "all" });
  if (Result.isSuccess(result)) return result.success;
  throw new HttpFailure(400, {
    error: "Invalid widget config",
    issues: formatIssues(result.failure.issue).issues,
  });
}

/**
 * Why a widget may not point where its config says, or null.
 *
 * A report or canvas card shows that object's numbers, so only one the caller
 * can open may be placed, whether directly or as a KPI's source. Throws the
 * sharing 403 when the object exists but is not shared with the caller.
 */
async function widgetTargetProblem(
  organizationId: string,
  kind: DashboardWidgetKind,
  config: unknown,
): Promise<string | null> {
  const source = field(config, "source");
  const reportId =
    kind === "cost_report"
      ? field(config, "reportId")
      : kind === "kpi" && field(source, "kind") === "cost_report"
        ? field(source, "reportId")
        : undefined;
  if (Predicate.isString(reportId)) {
    const meta = await loadObjectMeta(organizationId, "cost_report", reportId);
    if (!meta) return "Report not found";
    await requireObjectAccess(organizationId, "cost_report", reportId, meta, "viewer");
  }
  const canvasId = kind === "cost_canvas" ? field(config, "canvasId") : undefined;
  if (Predicate.isString(canvasId)) {
    const meta = await loadObjectMeta(organizationId, "cost_canvas", canvasId);
    if (!meta) return "Canvas not found";
    await requireObjectAccess(organizationId, "cost_canvas", canvasId, meta, "viewer");
  }
  return null;
}

/** What a new widget's body may carry, as the handler decoded it. */
export interface WidgetCreateBody {
  readonly dashboardId?: unknown;
  readonly kind?: unknown;
  readonly title?: string | null;
  readonly config?: unknown;
}

/** POST /widgets: add a cost-graph or budget widget. */
export async function createWidget(organizationId: string, body: WidgetCreateBody) {
  const kind = body.kind;
  if (!isWidgetKind(kind)) throw new DashboardRefusal(400, "Invalid widget kind");
  if (!body.dashboardId) throw new DashboardRefusal(400, "dashboardId is required");
  // An id of another type matches no row, as the route's query did.
  const dashboardId = Predicate.isString(body.dashboardId) ? body.dashboardId : undefined;

  const [dashboard] =
    dashboardId === undefined
      ? []
      : await db
          .select({ id: dashboards.id })
          .from(dashboards)
          .where(
            and(
              eq(dashboards.id, dashboardId),
              eq(dashboards.organizationId, organizationId),
              isNull(dashboards.deletedAt),
            ),
          )
          .limit(1);
  if (!dashboard) throw new DashboardRefusal(404, "Dashboard not found");
  // Sharing: changing what a dashboard shows needs editor on it.
  await requireObjectAccess(organizationId, "dashboard", dashboard.id, {}, "editor");

  const config = decodeWidgetConfig(kind, body.config);

  const missing = await widgetTargetProblem(organizationId, kind, config);
  if (missing) throw new DashboardRefusal(404, missing);

  const size = defaultWidgetSize(kind);
  const [created] = await db
    .insert(dashboardWidgets)
    .values({
      id: uuidv4(),
      organizationId,
      dashboardId: dashboard.id,
      kind,
      title: body.title ?? "",
      config,
      gridX: await nextGridX(dashboard.id),
      gridW: size.w,
      gridH: size.h,
    })
    .returning();
  if (!created) throw new Error("Widget insert returned no row");
  return { created, dashboardId: dashboard.id, kind };
}

/** The live widget, when it is in the org and the caller may edit its dashboard. */
async function editableWidget(organizationId: string, widgetId: string) {
  const [widget] = await db
    .select()
    .from(dashboardWidgets)
    .where(
      and(
        eq(dashboardWidgets.id, widgetId),
        eq(dashboardWidgets.organizationId, organizationId),
        isNull(dashboardWidgets.deletedAt),
      ),
    )
    .limit(1);
  if (!widget) throw new DashboardRefusal(404, "Not found");
  await requireObjectAccess(organizationId, "dashboard", widget.dashboardId, {}, "editor");
  return widget;
}

/**
 * POST /widgets/:widgetId/duplicate: copy a card in place.
 *
 * The copy keeps the original's kind, config and size and lands right after
 * it: every card behind the original moves one slot along the shared
 * sequence, in one transaction, so the grid never shows two cards on one
 * slot. A copy of a budget or report card is a second view onto the same
 * budget or report, never a second budget or report.
 */
export async function duplicateWidget(organizationId: string, widgetId: string) {
  const widget = await editableWidget(organizationId, widgetId);
  const kind = widget.kind;
  if (!isWidgetKind(kind)) {
    throw new DashboardRefusal(400, "This card type cannot be copied by this version");
  }
  const missing = await widgetTargetProblem(organizationId, kind, widget.config);
  if (missing) throw new DashboardRefusal(404, missing);

  const siblings = await db
    .select({ title: dashboardWidgets.title })
    .from(dashboardWidgets)
    .where(
      and(eq(dashboardWidgets.dashboardId, widget.dashboardId), isNull(dashboardWidgets.deletedAt)),
    );
  const title = widget.title
    ? duplicateCostReportName(
        widget.title,
        siblings.map((s) => s.title),
      )
    : "";
  const slot = widget.gridX + 1;
  const created = await db.transaction(async (tx) => {
    await tx
      .update(dashboardPins)
      .set({
        gridX: sql`${dashboardPins.gridX} + 1`,
        // Resource pins are the card kind desktop sync carries, so a moved
        // pin must read as changed to it, as a reorder does.
        syncVersion: nextPinSyncVersion(organizationId),
      })
      .where(
        and(eq(dashboardPins.dashboardId, widget.dashboardId), gte(dashboardPins.gridX, slot)),
      );
    await tx
      .update(dashboardWorkflowPins)
      .set({ gridX: sql`${dashboardWorkflowPins.gridX} + 1` })
      .where(
        and(
          eq(dashboardWorkflowPins.dashboardId, widget.dashboardId),
          gte(dashboardWorkflowPins.gridX, slot),
        ),
      );
    await tx
      .update(dashboardWidgets)
      .set({ gridX: sql`${dashboardWidgets.gridX} + 1` })
      .where(
        and(
          eq(dashboardWidgets.dashboardId, widget.dashboardId),
          gte(dashboardWidgets.gridX, slot),
          isNull(dashboardWidgets.deletedAt),
        ),
      );
    const [row] = await tx
      .insert(dashboardWidgets)
      .values({
        id: uuidv4(),
        organizationId,
        dashboardId: widget.dashboardId,
        kind,
        title,
        config: widget.config,
        gridX: slot,
        gridY: widget.gridY,
        gridW: widget.gridW,
        gridH: widget.gridH,
      })
      .returning();
    if (!row) throw new Error("Widget insert returned no row");
    return row;
  });
  return { created, dashboardId: widget.dashboardId, kind, sourceWidgetId: widget.id };
}

/** What a widget update's body may carry, as the handler decoded it. */
export interface WidgetUpdateBody {
  readonly title?: string;
  readonly config?: unknown;
  readonly gridX?: unknown;
  readonly gridY?: unknown;
  readonly gridW?: unknown;
  readonly gridH?: unknown;
}

/** PATCH /widgets/:widgetId: update title/config/layout. */
export async function updateWidget(
  organizationId: string,
  widgetId: string,
  body: WidgetUpdateBody,
) {
  const widget = await editableWidget(organizationId, widgetId);

  const updates: Partial<typeof dashboardWidgets.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.config !== undefined) {
    // A stored kind this version does not know has no schema to check against.
    const kind = widget.kind;
    if (!isWidgetKind(kind)) {
      throw new HttpFailure(400, { error: "Invalid widget config", issues: [] });
    }
    const config = decodeWidgetConfig(kind, body.config);
    const missing = await widgetTargetProblem(organizationId, kind, config);
    if (missing) throw new DashboardRefusal(404, missing);
    updates.config = config;
  }
  for (const key of ["gridX", "gridY"] as const) {
    const value = body[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) updates[key] = value;
  }
  // A span is a card's size in grid tracks: at least one, and at most what
  // org config as code can express, so a document always round-trips it.
  for (const [key, max] of [
    ["gridW", DASHBOARD_GRID_LIMITS.maxWidth],
    ["gridH", DASHBOARD_GRID_LIMITS.maxHeight],
  ] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
      throw new DashboardRefusal(400, `${key} must be a whole number from 1 to ${max}`);
    }
    updates[key] = value;
  }

  const [updated] = await db
    .update(dashboardWidgets)
    .set(updates)
    .where(eq(dashboardWidgets.id, widget.id))
    .returning();
  return { updated, dashboardId: widget.dashboardId, kind: widget.kind };
}

/** DELETE /widgets/:widgetId: soft delete. */
export async function deleteWidget(organizationId: string, widgetId: string) {
  const [target] = await db
    .select({ dashboardId: dashboardWidgets.dashboardId })
    .from(dashboardWidgets)
    .where(
      and(eq(dashboardWidgets.id, widgetId), eq(dashboardWidgets.organizationId, organizationId)),
    )
    .limit(1);
  if (!target) throw new DashboardRefusal(404, "Not found");
  await requireObjectAccess(organizationId, "dashboard", target.dashboardId, {}, "editor");

  const [deleted] = await db
    .update(dashboardWidgets)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(dashboardWidgets.id, widgetId),
        eq(dashboardWidgets.organizationId, organizationId),
        isNull(dashboardWidgets.deletedAt),
      ),
    )
    .returning({ id: dashboardWidgets.id });
  if (!deleted) throw new DashboardRefusal(404, "Not found");
  return { id: deleted.id, dashboardId: target.dashboardId };
}
