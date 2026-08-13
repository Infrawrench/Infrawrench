/**
 * Wire-shape assembly for the schedules API — rows joined with resource and
 * account display names, annotated with the projected monthly saving computed
 * from trailing `cost_daily` spend and the schedule's weekly off-hours
 * fraction. Shared by the HTTP routes, the MCP tools and (for the preview)
 * the editor UIs' quote.
 *
 * Cost annotation follows the orphan finder exactly: best-effort, matched in
 * memory against `resources.external_id`, mixed-currency matches dropped, and
 * a ClickHouse failure yields `null` — a missing bill quotes nothing, never
 * $0.00.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  computeUpcomingTransitions,
  projectedMonthlySaving,
  validateScheduleTiming,
  weeklyOffFraction,
  type SchedulePreview,
  type SchedulePreviewRequest,
  type SleepSchedule,
  type SleepScheduleListResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { getResourceCostTotals } from "../clickhouse/cost-readers";
import { addDays, isoDay } from "../cost/dates";
import { ScheduleInputError, listScheduleRecords, type ScheduleRecord } from "./store";

export const SCHEDULE_COST_WINDOW_DAYS = 30;

interface CostTotalEntry {
  amount: number;
  currency: string | null; // null = mixed currencies, annotation dropped
}

/**
 * Trailing-window spend per `${accountId} ${externalId}` key. Returns null
 * when ClickHouse is unreachable/unconfigured — schedules still work without
 * billing data.
 */
async function loadCostTotals(organizationId: string): Promise<Map<string, CostTotalEntry> | null> {
  const to = isoDay(new Date());
  const from = addDays(to, -(SCHEDULE_COST_WINDOW_DAYS - 1));
  // Only the ClickHouse read is allowed to fail; a bug in the merge below must
  // throw, not read as "ClickHouse down".
  let totals: Awaited<ReturnType<typeof getResourceCostTotals>>;
  try {
    totals = await getResourceCostTotals(organizationId, from, to);
  } catch (err) {
    console.warn(`[schedules] cost totals for org ${organizationId} unavailable:`, err);
    return null;
  }
  const byKey = new Map<string, CostTotalEntry>();
  for (const t of totals) {
    const key = `${t.accountId} ${t.resourceId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { amount: t.amount, currency: t.currency });
    } else if (existing.currency !== null && existing.currency !== t.currency) {
      existing.currency = null;
    } else {
      existing.amount += t.amount;
    }
  }
  return byKey;
}

function toWire(
  row: ScheduleRecord,
  names: {
    resourceName: string;
    accountName: string;
    externalId: string | null;
  },
  cost: CostTotalEntry | null,
): SleepSchedule {
  const timing = {
    daysOfWeek: row.daysOfWeek,
    stopTime: row.stopTime,
    startTime: row.startTime,
    timezone: row.timezone,
  };
  const fraction = weeklyOffFraction(timing);
  const saving =
    cost && cost.currency !== null
      ? projectedMonthlySaving(cost.amount, SCHEDULE_COST_WINDOW_DAYS, fraction)
      : null;
  return {
    id: row.id,
    resourceId: row.resourceId,
    accountId: row.accountId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    resourceName: names.resourceName,
    accountName: names.accountName,
    daysOfWeek: row.daysOfWeek,
    stopTime: row.stopTime,
    startTime: row.startTime,
    timezone: row.timezone,
    paused: row.paused,
    nextTransitionAt: row.nextTransitionAt ? row.nextTransitionAt.toISOString() : null,
    nextTransitionAction: row.nextTransitionAction,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastRunAction: row.lastRunAction,
    lastRunStatus: row.lastRunStatus,
    lastRunError: row.lastRunError,
    projectedMonthlySaving: saving,
    currency: saving !== null && cost ? cost.currency : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All schedules for the org, with names and projected savings. */
export async function listSchedules(organizationId: string): Promise<SleepScheduleListResponse> {
  const rows = await listScheduleRecords(organizationId);
  if (rows.length === 0) return { schedules: [] };

  const resourceIds = [...new Set(rows.map((r) => r.resourceId))];
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const [resourceRows, accountRows, costTotals] = await Promise.all([
    db
      .select({
        id: resources.id,
        displayName: resources.displayName,
        externalId: resources.externalId,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, resourceIds))),
    db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, accountIds))),
    loadCostTotals(organizationId),
  ]);
  const resourceById = new Map(resourceRows.map((r) => [r.id, r]));
  const accountById = new Map(accountRows.map((a) => [a.id, a]));

  return {
    schedules: rows.map((row) => {
      const resource = resourceById.get(row.resourceId);
      const externalId = resource?.externalId ?? null;
      const cost =
        costTotals && externalId
          ? (costTotals.get(`${row.accountId} ${externalId}`) ?? null)
          : null;
      return toWire(
        row,
        {
          resourceName: resource?.displayName ?? row.resourceId,
          accountName: accountById.get(row.accountId)?.displayName ?? row.accountId,
          externalId,
        },
        cost,
      );
    }),
  };
}

/** One schedule in wire shape (savings-annotated), or null. */
export async function getScheduleWire(
  organizationId: string,
  scheduleId: string,
): Promise<SleepSchedule | null> {
  const { schedules } = await listSchedules(organizationId);
  return schedules.find((s) => s.id === scheduleId) ?? null;
}

/**
 * Quote a timing against a resource before saving: off-hours fraction, the
 * trailing spend normalized to a month, the projected saving, and the next
 * few transitions so the user can sanity-check the timezone.
 */
export async function previewSchedule(
  organizationId: string,
  request: SchedulePreviewRequest,
): Promise<SchedulePreview> {
  const timingError = validateScheduleTiming(request);
  if (timingError) throw new ScheduleInputError(timingError);

  const [resource] = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      externalId: resources.externalId,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, request.resourceId)))
    .limit(1);
  if (!resource) throw new ScheduleInputError("Resource not found in this organization", 404);

  const fraction = weeklyOffFraction(request);
  const costTotals = await loadCostTotals(organizationId);
  const cost =
    costTotals && resource.externalId
      ? (costTotals.get(`${resource.accountId} ${resource.externalId}`) ?? null)
      : null;
  const monthlyCost =
    cost && cost.currency !== null
      ? projectedMonthlySaving(cost.amount, SCHEDULE_COST_WINDOW_DAYS, 1)
      : null;
  return {
    offFraction: fraction,
    monthlyCost,
    projectedMonthlySaving: monthlyCost !== null ? monthlyCost * fraction : null,
    currency: monthlyCost !== null && cost ? cost.currency : null,
    costWindowDays: cost ? SCHEDULE_COST_WINDOW_DAYS : 0,
    nextTransitions: computeUpcomingTransitions(request, { count: 4 }),
  };
}
