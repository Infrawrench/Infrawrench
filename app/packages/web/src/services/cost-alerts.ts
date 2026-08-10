/**
 * Org-scoped change-based cost alert CRUD + fired-event listing — shared by
 * the HTTP routes (api/routes/cost-alerts.ts) and the tool registry
 * (tools/cost-alerts.ts), like every other cost service.
 *
 * Evaluation itself lives in server-core (`cost/change-eval.ts`) and runs
 * from the poller after cost collection; nothing here fires an alert.
 */
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  COST_ALERT_LIMITS,
  type CostAlert,
  type CostAlertEvent,
  type CostAlertInput,
  type CostChangeCadence,
  type CostChangeDirection,
  type CostDimensionId,
  type CostFilter,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costAlertEvents, costAlerts } from "../db/schema";

type CostAlertRow = typeof costAlerts.$inferSelect;

/** Thrown when an org is at its alert cap; the route maps it to a 400. */
export class CostAlertLimitError extends Error {
  constructor() {
    super(`An organization can have at most ${COST_ALERT_LIMITS.maxAlertsPerOrg} cost alerts`);
    this.name = "CostAlertLimitError";
  }
}

function toWire(row: CostAlertRow, lastFiredAt: Date | null): CostAlert {
  return {
    id: row.id,
    name: row.name,
    filters: (row.filters ?? []) as CostFilter[],
    groupBy: (row.groupBy ?? null) as CostDimensionId | null,
    groupByTagKey: row.groupByTagKey ?? null,
    cadence: row.cadence as CostChangeCadence,
    thresholdPercent: row.thresholdPercent,
    thresholdAmountCents: row.thresholdAmountCents,
    direction: row.direction as CostChangeDirection,
    enabled: row.enabled,
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
    lastFiredAt: lastFiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Most recent `firedAt` per alert, for the "last fired" column. */
async function loadLastFired(alertIds: string[]): Promise<Map<string, Date>> {
  const byAlert = new Map<string, Date>();
  if (alertIds.length === 0) return byAlert;
  const rows = await db
    .select({ alertId: costAlertEvents.alertId, last: max(costAlertEvents.firedAt) })
    .from(costAlertEvents)
    .where(inArray(costAlertEvents.alertId, alertIds))
    .groupBy(costAlertEvents.alertId);
  for (const row of rows) {
    if (row.last) byAlert.set(row.alertId, row.last);
  }
  return byAlert;
}

/** The org's change alerts, oldest first, with last-fired info. */
export async function listCostAlerts(organizationId: string): Promise<CostAlert[]> {
  const rows = await db
    .select()
    .from(costAlerts)
    .where(and(eq(costAlerts.organizationId, organizationId), isNull(costAlerts.deletedAt)))
    .orderBy(costAlerts.createdAt);
  const lastFired = await loadLastFired(rows.map((r) => r.id));
  return rows.map((row) => toWire(row, lastFired.get(row.id) ?? null));
}

/** One change alert, or null when not found. */
export async function getCostAlert(
  organizationId: string,
  alertId: string,
): Promise<CostAlert | null> {
  const [row] = await db
    .select()
    .from(costAlerts)
    .where(
      and(
        eq(costAlerts.id, alertId),
        eq(costAlerts.organizationId, organizationId),
        isNull(costAlerts.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const lastFired = await loadLastFired([row.id]);
  return toWire(row, lastFired.get(row.id) ?? null);
}

export async function createCostAlert(
  organizationId: string,
  input: CostAlertInput,
  createdByUserId: string | null,
): Promise<CostAlert> {
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)` })
    .from(costAlerts)
    .where(and(eq(costAlerts.organizationId, organizationId), isNull(costAlerts.deletedAt)))) as [
    { n: number },
  ];
  if (Number(n) >= COST_ALERT_LIMITS.maxAlertsPerOrg) throw new CostAlertLimitError();

  const [created] = await db
    .insert(costAlerts)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name,
      filters: input.filters,
      groupBy: input.groupBy,
      // The tag key only means something under a tag grouping; storing a
      // stale one under another grouping would silently resurface if the
      // alert is later switched back.
      groupByTagKey: input.groupBy === "tag" ? (input.groupByTagKey ?? null) : null,
      cadence: input.cadence,
      thresholdPercent: input.thresholdPercent,
      thresholdAmountCents: input.thresholdAmountCents,
      direction: input.direction,
      enabled: input.enabled,
      createdByUserId,
    })
    .returning();
  return toWire(created!, null);
}

/** Update a change alert. Null when not found. */
export async function updateCostAlert(
  organizationId: string,
  alertId: string,
  input: CostAlertInput,
): Promise<CostAlert | null> {
  const [updated] = await db
    .update(costAlerts)
    .set({
      name: input.name,
      filters: input.filters,
      groupBy: input.groupBy,
      groupByTagKey: input.groupBy === "tag" ? (input.groupByTagKey ?? null) : null,
      cadence: input.cadence,
      thresholdPercent: input.thresholdPercent,
      thresholdAmountCents: input.thresholdAmountCents,
      direction: input.direction,
      enabled: input.enabled,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(costAlerts.id, alertId),
        eq(costAlerts.organizationId, organizationId),
        isNull(costAlerts.deletedAt),
      ),
    )
    .returning();
  if (!updated) return null;
  const lastFired = await loadLastFired([updated.id]);
  return toWire(updated, lastFired.get(updated.id) ?? null);
}

/** Soft-delete a change alert. False when not found. */
export async function softDeleteCostAlert(
  organizationId: string,
  alertId: string,
): Promise<boolean> {
  const now = new Date();
  const [deleted] = await db
    .update(costAlerts)
    .set({ deletedAt: now, updatedAt: now, enabled: false })
    .where(
      and(
        eq(costAlerts.id, alertId),
        eq(costAlerts.organizationId, organizationId),
        isNull(costAlerts.deletedAt),
      ),
    )
    .returning({ id: costAlerts.id });
  return Boolean(deleted);
}

/**
 * Recently fired events, newest first, optionally scoped to one alert.
 *
 * The org-wide list hides events whose alert was soft-deleted — the section
 * header they would render under no longer exists. Scoped to an `alertId`,
 * the alert is looked up first and null means "no such alert" (a 404),
 * distinct from "no events yet" (an empty array).
 */
export async function listCostAlertEventsForOrg(
  organizationId: string,
  options: { alertId?: string; limit?: number } = {},
): Promise<CostAlertEvent[] | null> {
  const limit = Math.min(
    Math.max(
      options.limit ?? COST_ALERT_LIMITS.defaultEventsLimit,
      COST_ALERT_LIMITS.minEventsLimit,
    ),
    COST_ALERT_LIMITS.maxEventsLimit,
  );

  if (options.alertId) {
    const [alert] = await db
      .select({ id: costAlerts.id })
      .from(costAlerts)
      .where(
        and(
          eq(costAlerts.id, options.alertId),
          eq(costAlerts.organizationId, organizationId),
          isNull(costAlerts.deletedAt),
        ),
      )
      .limit(1);
    if (!alert) return null;
  }

  const rows = await db
    .select({ event: costAlertEvents, alertName: costAlerts.name })
    .from(costAlertEvents)
    .innerJoin(costAlerts, eq(costAlerts.id, costAlertEvents.alertId))
    .where(
      and(
        eq(costAlertEvents.organizationId, organizationId),
        isNull(costAlerts.deletedAt),
        ...(options.alertId ? [eq(costAlertEvents.alertId, options.alertId)] : []),
      ),
    )
    .orderBy(desc(costAlertEvents.firedAt))
    .limit(limit);

  return rows.map(({ event, alertName }) => ({
    id: event.id,
    alertId: event.alertId,
    alertName,
    periodKey: event.periodKey,
    windowFrom: event.windowFrom,
    windowTo: event.windowTo,
    previousFrom: event.previousFrom,
    previousTo: event.previousTo,
    groupKey: event.groupKey,
    currency: event.currency,
    previousAmountCents: event.previousAmountCents,
    currentAmountCents: event.currentAmountCents,
    changePercent: event.changePercent,
    direction: event.direction,
    firedAt: event.firedAt.toISOString(),
    notifiedAt: event.notifiedAt?.toISOString() ?? null,
  }));
}
