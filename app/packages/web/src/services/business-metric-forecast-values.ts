/**
 * Forecasted (planned) values of a business metric: storage and reads.
 *
 * Kept in their own table and their own module so that nothing that divides by
 * a metric (unit costs, thresholds, coverage) can read a plan as if it were a
 * measurement; see `business_metric_forecast_values` in the schema. The only
 * consumer that projects with them is a cost report's driver-metric forecast.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import {
  businessMetricForecastValuesError,
  type BusinessMetricForecastValue,
  type BusinessMetricForecastValueInput,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { businessMetricForecastValues } from "../db/schema";

/** A batch the API refuses (400). */
export class BusinessMetricForecastValueError extends Error {
  override readonly name = "BusinessMetricForecastValueError";
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Validate an optional inclusive day range from a query string. */
export function parseForecastValueRange(
  from: string | undefined,
  to: string | undefined,
): { from?: string; to?: string } {
  if (from !== undefined && !ISO_DAY.test(from)) {
    throw new BusinessMetricForecastValueError("from must be YYYY-MM-DD");
  }
  if (to !== undefined && !ISO_DAY.test(to)) {
    throw new BusinessMetricForecastValueError("to must be YYYY-MM-DD");
  }
  if (from && to && from > to)
    throw new BusinessMetricForecastValueError("from must not be after to");
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/** A metric's forecasted values in day order, optionally within `[from, to]`. */
export async function listBusinessMetricForecastValues(
  metricId: string,
  range: { from?: string; to?: string } = {},
  limit = 1000,
): Promise<BusinessMetricForecastValue[]> {
  const rows = await db
    .select()
    .from(businessMetricForecastValues)
    .where(
      and(
        eq(businessMetricForecastValues.metricId, metricId),
        range.from ? gte(businessMetricForecastValues.day, range.from) : undefined,
        range.to ? lte(businessMetricForecastValues.day, range.to) : undefined,
      ),
    )
    .orderBy(asc(businessMetricForecastValues.day))
    .limit(Math.min(Math.max(Math.round(limit), 1), 5000));
  return rows.map((r) => ({
    day: r.day,
    value: Number(r.value),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** `day -> value` for a driver forecast's horizon. */
export async function getBusinessMetricForecastMap(
  metricId: string,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const values = await listBusinessMetricForecastValues(metricId, { from, to }, 5000);
  return new Map(values.map((v) => [v.day, v.value]));
}

/**
 * Write a batch of forecasted days. Re-sending a day restates it, exactly as
 * actuals do, so a planning spreadsheet re-uploaded after an edit replaces
 * rather than doubles.
 */
export async function writeBusinessMetricForecastValues(
  organizationId: string,
  metricId: string,
  values: BusinessMetricForecastValueInput[],
  userId: string | null,
): Promise<{ written: number }> {
  const problem = businessMetricForecastValuesError(values);
  if (problem) throw new BusinessMetricForecastValueError(problem);
  const now = new Date();
  await db
    .insert(businessMetricForecastValues)
    .values(
      values.map((v) => ({
        id: uuidv4(),
        organizationId,
        metricId,
        day: v.date,
        value: v.value,
        updatedByUserId: userId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [businessMetricForecastValues.metricId, businessMetricForecastValues.day],
      set: {
        value: sql`excluded.value`,
        updatedByUserId: sql`excluded.updated_by_user_id`,
        updatedAt: now,
      },
    });
  return { written: values.length };
}

/**
 * Delete forecasted days in `[from, to]` (both optional: absent bounds are
 * open). Returns how many days were removed.
 */
export async function deleteBusinessMetricForecastValues(
  metricId: string,
  range: { from?: string; to?: string },
): Promise<{ deleted: number }> {
  const deleted = await db
    .delete(businessMetricForecastValues)
    .where(
      and(
        eq(businessMetricForecastValues.metricId, metricId),
        range.from ? gte(businessMetricForecastValues.day, range.from) : undefined,
        range.to ? lte(businessMetricForecastValues.day, range.to) : undefined,
      ),
    )
    .returning({ id: businessMetricForecastValues.id });
  return { deleted: deleted.length };
}
