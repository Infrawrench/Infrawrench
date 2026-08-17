/**
 * The alert noise report — reading the delivery log and asking whether anybody
 * acted on any of it.
 *
 * All the reasoning is in `@infrawrench/client-core` (`buildNoiseReport`), so
 * this module is only the read: pull one window of `alert_deliveries` and hand
 * it over. That split is what lets the settings page show the same verdict the
 * API returns without a second implementation of the heuristic.
 */
import { and, gte, eq } from "drizzle-orm";
import { buildNoiseReport, NOISE_LIMITS, type NoiseReport } from "@infrawrench/client-core";

import { db } from "../db/client";
import { alertDeliveries } from "../db/schema";

export interface NoiseReportOptions {
  /** How far back to read. Defaults to 30 days. */
  windowDays?: number;
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
}

/**
 * The report for one org.
 *
 * The row cap is deliberate and generous: an org that has genuinely produced
 * more than this in a month is *already* the answer the report exists to give,
 * and reading a million rows to say so would be a strange way to spend a
 * database.
 */
const MAX_ROWS = 20_000;

export async function getNoiseReport(
  organizationId: string,
  options: NoiseReportOptions = {},
): Promise<NoiseReport> {
  const now = options.now ?? Date.now();
  const windowDays = Math.min(
    Math.max(options.windowDays ?? NOISE_LIMITS.defaultWindowDays, NOISE_LIMITS.minWindowDays),
    NOISE_LIMITS.maxWindowDays,
  );
  const from = new Date(now - windowDays * 86_400_000);

  const rows = await db
    .select({
      trigger: alertDeliveries.trigger,
      severity: alertDeliveries.severity,
      ruleId: alertDeliveries.ruleId,
      ruleName: alertDeliveries.ruleName,
      state: alertDeliveries.state,
      createdAt: alertDeliveries.createdAt,
      acknowledgedAt: alertDeliveries.acknowledgedAt,
    })
    .from(alertDeliveries)
    .where(
      and(eq(alertDeliveries.organizationId, organizationId), gte(alertDeliveries.createdAt, from)),
    )
    .limit(MAX_ROWS);

  return buildNoiseReport(
    rows.map((row) => ({
      trigger: row.trigger,
      severity: row.severity,
      ruleId: row.ruleId,
      // The rule's name is denormalized onto the delivery, which is what lets
      // this report still name a rule somebody has since deleted — and a
      // deleted noisy rule is a useful thing to see, not a gap.
      ruleName: row.ruleName,
      state: row.state,
      createdAt: row.createdAt.toISOString(),
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    })),
    {
      from: from.toISOString(),
      to: new Date(now).toISOString(),
      generatedAt: new Date(now).toISOString(),
    },
  );
}
