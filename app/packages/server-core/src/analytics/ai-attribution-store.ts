/**
 * Reads and writes for the two AI attribution tables (`ai_request_daily`,
 * `ai_cost_attributed`). See their declarations in `schema.ts`.
 *
 * Both tables are append-only and readers take the latest collection or run,
 * so each write is one transaction: a reader must never see half a collection
 * (or half a run's split) as the newest one. An attribution run reads the
 * aggregates a collection has just written, and the stats endpoint reads the
 * split a run has just written, so both rely on the write being committed by
 * the time it returns, which a transaction gives them.
 */
import type { AiRequestAggregate } from "@infrawrench/plugin-base";
import { and, eq, inArray, sql, type InferInsertModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { getAnalyticsDb } from "./client";
import { hashTags } from "./cost-writers";
import { aiCostAttributed, aiRequestDaily, costDaily } from "./schema";

/**
 * Rows per statement: comfortably inside Postgres's 65,535 bind-parameter cap
 * for both tables (17 and 19 columns).
 */
const INSERT_BATCH_ROWS = 1000;

async function insertRows<TTable extends PgTable>(
  table: TTable,
  rows: InferInsertModel<TTable>[],
): Promise<void> {
  if (rows.length === 0) return;
  await getAnalyticsDb().transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += INSERT_BATCH_ROWS) {
      await tx.insert(table).values(rows.slice(i, i + INSERT_BATCH_ROWS));
    }
  });
}

/** Write one collection of one source-day. A later collection supersedes it. */
export async function insertAiRequestAggregates(
  organizationId: string,
  sourceId: string,
  day: string,
  collectedAt: string,
  aggregates: AiRequestAggregate[],
): Promise<void> {
  await insertRows(
    aiRequestDaily,
    aggregates.map((a) => ({
      organization_id: organizationId,
      source_id: sourceId,
      day,
      collected_at: collectedAt,
      provider: a.provider,
      model: a.model,
      metadata: a.metadata,
      requests: Math.max(0, Math.floor(a.requests)),
      input_tokens: Math.max(0, Math.floor(a.inputTokens)),
      output_tokens: Math.max(0, Math.floor(a.outputTokens)),
      cache_read_tokens: Math.max(0, Math.floor(a.cacheReadTokens)),
      cache_write_tokens: Math.max(0, Math.floor(a.cacheWriteTokens)),
      reasoning_tokens: Math.max(0, Math.floor(a.reasoningTokens)),
      reported_cost: a.reportedCost ?? 0,
      reported_cost_known: a.reportedCost === undefined ? 0 : 1,
      reported_currency: a.reportedCurrency ?? "",
    })),
  );
}

export interface StoredAiAggregate {
  sourceId: string;
  provider: string;
  model: string;
  metadata: Record<string, string>;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  reportedCost: number | null;
  reportedCurrency: string | null;
}

/** The latest collection of every source for one org-day. */
export async function readLatestAiAggregates(
  organizationId: string,
  day: string,
  sourceIds: string[],
): Promise<StoredAiAggregate[]> {
  if (sourceIds.length === 0) return [];
  const t = aiRequestDaily;
  const rows = await getAnalyticsDb()
    .select()
    .from(t)
    .where(
      and(
        eq(t.organization_id, organizationId),
        eq(t.day, day),
        inArray(t.source_id, sourceIds),
        sql`(${t.source_id}, ${t.collected_at}) IN (SELECT ${t.source_id}, max(${t.collected_at}) FROM ${t} WHERE ${t.organization_id} = ${organizationId} AND ${t.day} = ${day}::date GROUP BY ${t.source_id})`,
      ),
    );
  return rows.map((r) => ({
    sourceId: r.source_id,
    provider: r.provider,
    model: r.model,
    metadata: r.metadata ?? {},
    requests: Number(r.requests),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    reportedCost: Number(r.reported_cost_known) ? Number(r.reported_cost) : null,
    reportedCurrency: r.reported_currency || null,
  }));
}

/** A billed AI row as the attribution run copies it into its splits. */
export interface BilledAiCostRow {
  account_id: string;
  plugin_id: string;
  day: string;
  service: string;
  region: string;
  resource_id: string;
  tags: Record<string, string>;
  currency: string;
  amount: number;
  usage_amount: number;
  usage_unit: string;
  charge_type: string;
  amortized_amount: number;
  amortized_reported: number;
  commitment_id: string;
}

/**
 * Every `cost_daily` row of an org-day that a plugin tagged with `ai:provider`.
 *
 * A system read, like `cost-reconcile.ts`: the attribution run must split the
 * whole bill whatever context it runs in, so it deliberately does not go
 * through `costDailyOrgCondition`'s visibility layers.
 */
export async function readBilledAiRows(
  organizationId: string,
  day: string,
): Promise<BilledAiCostRow[]> {
  const c = costDaily;
  const rows = await getAnalyticsDb()
    .select({
      account_id: c.account_id,
      plugin_id: c.plugin_id,
      day: c.day,
      service: c.service,
      region: c.region,
      resource_id: c.resource_id,
      tags: c.tags,
      currency: c.currency,
      amount: c.amount,
      usage_amount: c.usage_amount,
      usage_unit: c.usage_unit,
      charge_type: c.charge_type,
      amortized_amount: c.amortized_amount,
      amortized_reported: c.amortized_reported,
      commitment_id: c.commitment_id,
    })
    .from(c)
    .where(
      and(
        eq(c.organization_id, organizationId),
        eq(c.day, day),
        sql`jsonb_exists(${c.tags}, 'ai:provider')`,
      ),
    );
  return rows.map((r) => ({
    ...r,
    tags: r.tags ?? {},
    amount: Number(r.amount),
    usage_amount: Number(r.usage_amount),
    amortized_amount: Number(r.amortized_amount),
    amortized_reported: Number(r.amortized_reported),
  }));
}

/** Write one run's split rows for one org-day. */
export async function insertAttributedRows(
  organizationId: string,
  runAt: string,
  rows: BilledAiCostRow[],
): Promise<void> {
  await insertRows(
    aiCostAttributed,
    rows.map((r) => ({
      organization_id: organizationId,
      account_id: r.account_id,
      plugin_id: r.plugin_id,
      day: r.day,
      service: r.service,
      region: r.region,
      resource_id: r.resource_id,
      tags: r.tags,
      tags_hash: hashTags(r.tags, { chargeType: r.charge_type, commitmentId: r.commitment_id }),
      currency: r.currency,
      amount: r.amount,
      usage_amount: r.usage_amount,
      usage_unit: r.usage_unit,
      charge_type: r.charge_type,
      amortized_amount: r.amortized_amount,
      amortized_reported: r.amortized_reported,
      commitment_id: r.commitment_id,
      run_at: runAt,
    })),
  );
}
