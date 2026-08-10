/**
 * Read side of cost anomaly detection — the poller writes `cost_anomalies`
 * (server-core `cost/anomaly-eval.ts`); this lists them for the Costs panel
 * and the HTTP API.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import type { CostAnomaly } from "@infrawrench/client-core";
import { db } from "../db/client";
import { costAnomalies } from "../db/schema";

/** Hard cap on rows returned, whatever window was asked for. */
const MAX_ROWS = 200;

/**
 * Anomalies detected in the last `days` days (by anomalous day, not detection
 * time), newest day first, then largest overshoot first within a day.
 */
export async function listRecentCostAnomalies(
  organizationId: string,
  days: number,
): Promise<CostAnomaly[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(costAnomalies)
    .where(and(eq(costAnomalies.organizationId, organizationId), gte(costAnomalies.day, since)))
    .orderBy(desc(costAnomalies.day), desc(costAnomalies.actualAmountCents))
    .limit(MAX_ROWS);

  return rows.map((row) => ({
    id: row.id,
    day: row.day,
    kind: row.kind,
    dimension: row.dimension,
    dimensionKey: row.dimensionKey,
    currency: row.currency,
    actualCents: row.actualAmountCents,
    baselineCents: row.baselineAmountCents,
    thresholdCents: row.thresholdAmountCents,
    detectedAt: row.detectedAt.toISOString(),
    notifiedAt: row.notifiedAt ? row.notifiedAt.toISOString() : null,
    // Rows written before hints existed (or whose hint queries failed at
    // detection time) hold null; the wire contract is always an array.
    hints: row.hints ?? [],
  }));
}
