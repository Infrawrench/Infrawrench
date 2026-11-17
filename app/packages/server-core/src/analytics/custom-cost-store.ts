/**
 * ClickHouse side of custom cost sources: reading back what an upload holds,
 * and removing rows.
 *
 * **Removal is a tombstone, not a mutation**, for the reasons
 * `cost-reconcile.ts` gives: `cost_daily` is a ReplacingMergeTree, so a
 * zero-amount row written at an existing key supersedes it on the table's own
 * path, synchronously from the reader's point of view (`FINAL`), at the cost of
 * one row. An `ALTER TABLE … DELETE` would be an asynchronous part rewrite.
 *
 * A tombstone copies the stored row's `tags` and `tags_hash` verbatim, which
 * keeps the upload tag on it: a zeroed row still belongs to its upload, and
 * the holdings query below excludes it because it holds nothing.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getClickHouseDb, isClickHouseConfigured } from "./client";
import { dayRange } from "./cost-readers";
import type { CostDailyRow } from "./cost-writers";
import { insertCostRows } from "./cost-writers";
import { costDaily } from "./schema";

/** Mirrors `cost/custom-cost-ids.ts`; restated to keep this module db-schema-only. */
const UPLOAD_TAG = "infrawrench:upload";

/** Which of a source's rows to act on. */
export interface CustomCostRowScope {
  organizationId: string;
  /** `custom:<sourceId>` */
  pluginId: string;
  /** Inclusive day range; absent means every day. */
  from?: string | undefined;
  to?: string | undefined;
  /** Only rows written by this upload. */
  uploadId?: string | undefined;
  /** Every row except those written by this upload (a replace keeps its own). */
  excludeUploadId?: string | undefined;
}

/** A stored row still holding money or quantity. */
const HOLDS_SOMETHING = sql`(${costDaily.amount} != 0 OR ${costDaily.amortized_amount} != 0 OR ${costDaily.usage_amount} != 0)`;

// Both org predicates in this file bypass `costDailyOrgCondition` on purpose:
// tombstoning an upload and recomputing what uploads still hold are system
// writes, like `cost-reconcile.ts`, and must see every row whatever context
// they run in (a scoped read would zero only part of an upload). Scoped
// callers never reach them: `/custom-cost-sources` is in COST_SCOPE_DENY_RULES.
function scopeWhere(scope: CustomCostRowScope): SQL | undefined {
  return and(
    eq(costDaily.organization_id, scope.organizationId),
    eq(costDaily.plugin_id, scope.pluginId),
    scope.from && scope.to ? dayRange(scope.from, scope.to) : undefined,
    scope.uploadId ? sql`${costDaily.tags}[${UPLOAD_TAG}] = ${scope.uploadId}` : undefined,
    scope.excludeUploadId
      ? sql`${costDaily.tags}[${UPLOAD_TAG}] != ${scope.excludeUploadId}`
      : undefined,
    HOLDS_SOMETHING,
  );
}

/**
 * Zero every row in scope. Returns the upload ids whose rows were touched, so
 * the caller can recompute their holdings.
 *
 * Reads in pages by day so a source with years of resource-level history never
 * has to sit in memory at once; each page is written before the next is read.
 */
export async function tombstoneCustomCostRows(scope: CustomCostRowScope): Promise<{
  zeroed: number;
  uploadIds: string[];
}> {
  if (!isClickHouseConfigured()) return { zeroed: 0, uploadIds: [] };
  const db = getClickHouseDb();

  const days = await db
    .selectDistinct({ day: sql<string>`toString(${costDaily.day})`.as("day") })
    .from(costDaily)
    .final()
    .where(scopeWhere(scope))
    .orderBy(sql`day`);

  let zeroed = 0;
  const uploadIds = new Set<string>();
  for (const { day } of days) {
    const stored = await db
      .select({
        account_id: costDaily.account_id,
        day: sql<string>`toString(${costDaily.day})`.as("day"),
        service: costDaily.service,
        region: costDaily.region,
        resource_id: costDaily.resource_id,
        tags: costDaily.tags,
        tags_hash: costDaily.tags_hash,
        currency: costDaily.currency,
        charge_type: costDaily.charge_type,
        commitment_id: costDaily.commitment_id,
      })
      .from(costDaily)
      .final()
      .where(and(scopeWhere({ ...scope, from: day, to: day })));
    if (stored.length === 0) continue;
    const tombstones: CostDailyRow[] = stored.map((row) => {
      const upload = row.tags[UPLOAD_TAG];
      if (upload) uploadIds.add(upload);
      return {
        organization_id: scope.organizationId,
        account_id: row.account_id,
        plugin_id: scope.pluginId,
        day: row.day,
        service: row.service,
        region: row.region,
        resource_id: row.resource_id,
        tags: row.tags,
        tags_hash: row.tags_hash,
        currency: row.currency,
        amount: 0,
        usage_amount: 0,
        usage_unit: "",
        charge_type: row.charge_type,
        amortized_amount: 0,
        amortized_reported: 0,
        commitment_id: row.commitment_id,
        list_amount: 0,
        list_reported: 0,
        blended_amount: 0,
        blended_reported: 0,
      };
    });
    await insertCostRows(tombstones);
    zeroed += tombstones.length;
  }
  return { zeroed, uploadIds: [...uploadIds] };
}

/** What one upload's rows still add up to. */
export interface CustomCostUploadHolding {
  uploadId: string;
  rowCount: number;
  fromDate: string | null;
  toDate: string | null;
  totals: Record<string, number>;
}

/** Recompute holdings for the given uploads from what is actually stored. */
export async function getCustomCostUploadHoldings(
  organizationId: string,
  pluginId: string,
  uploadIds: string[],
): Promise<Map<string, CustomCostUploadHolding>> {
  const holdings = new Map<string, CustomCostUploadHolding>();
  for (const uploadId of uploadIds) {
    holdings.set(uploadId, { uploadId, rowCount: 0, fromDate: null, toDate: null, totals: {} });
  }
  if (!isClickHouseConfigured() || uploadIds.length === 0) return holdings;

  const uploadExpr = sql<string>`${costDaily.tags}[${UPLOAD_TAG}]`;
  const rows = await getClickHouseDb()
    .select({
      upload_id: uploadExpr.as("upload_id"),
      currency: costDaily.currency,
      rows: sql<number>`count()`.as("rows"),
      amount: sql<number>`sum(${costDaily.amount})`.as("amount"),
      from_day: sql<string>`toString(min(${costDaily.day}))`.as("from_day"),
      to_day: sql<string>`toString(max(${costDaily.day}))`.as("to_day"),
    })
    .from(costDaily)
    .final()
    .where(
      and(
        eq(costDaily.organization_id, organizationId),
        eq(costDaily.plugin_id, pluginId),
        inArray(uploadExpr, uploadIds),
        HOLDS_SOMETHING,
      ),
    )
    .groupBy(sql`upload_id`, costDaily.currency);

  for (const row of rows) {
    const holding = holdings.get(row.upload_id);
    if (!holding) continue;
    holding.rowCount += Number(row.rows);
    holding.totals[row.currency] = Number(row.amount);
    if (holding.fromDate === null || row.from_day < holding.fromDate)
      holding.fromDate = row.from_day;
    if (holding.toDate === null || row.to_day > holding.toDate) holding.toDate = row.to_day;
  }
  return holdings;
}
