/**
 * Validation and storage for cost rows Infrawrench did not collect itself.
 *
 * Two callers push spend this way and they must behave identically, so the
 * rules live here rather than in either of them:
 *
 * - `cost/workflow-costs.ts` — a workflow calling `infra.costs.write(...)`.
 * - `cost/external-costs.ts` — a server calling `POST /costs/rows`.
 *
 * **Why every pushed row carries a reserved tag.** `cost_daily` is a
 * ReplacingMergeTree keyed on
 * `(org, account, day, service, region, resource_id, tags_hash, currency)` —
 * `plugin_id` is NOT in that key, and the ORDER BY is frozen. So attributing a
 * pushed row to a real account could otherwise collide with a row the poller
 * collected for the same day/service and silently replace it. Every pushed row
 * therefore carries a reserved `infrawrench:`-prefixed tag naming its source,
 * which changes `tags_hash` and guarantees a disjoint key space. Re-pushing the
 * same source over the same days still replaces its OWN rows (same key, newer
 * `ingested_at`), which is exactly the restatement behaviour providers get.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { accounts } from "../db/schema";
import { hashTags, insertCostRows, type CostDailyRow } from "../clickhouse/cost-writers";
import { isClickHouseConfigured } from "../clickhouse/client";

/**
 * One day of spend for one dimension combination. Structurally the same shape
 * as workflow-runtime's `WorkflowCostRow` and the HTTP ingest body, so both
 * callers hand rows straight through.
 *
 * Fields are `unknown` because this module is the validator: rows arrive from
 * user code or off the wire, and every field is checked before it is used.
 */
export interface IngestCostRow {
  date: string;
  currency: string;
  amount: number;
  service?: string | undefined;
  region?: string | undefined;
  resourceId?: string | undefined;
  tags?: Record<string, string> | undefined;
  usageAmount?: number | undefined;
  usageUnit?: string | undefined;
  accountId?: string | undefined;
}

/** Where a batch of pushed rows came from, and how to key it. */
export interface CostIngestSource {
  /** `plugin_id` on every row — the value the "provider" dimension shows. */
  pluginId: string;
  /**
   * Reserved tag stamped on every row. Its value is what keeps this source's
   * ReplacingMergeTree key space disjoint from the pollers' — see the module
   * comment. The key must start with {@link RESERVED_TAG_PREFIX}.
   */
  tag: { key: string; value: string };
  /** `account_id` for rows that name no real account. */
  fallbackAccountId: string;
  /** Prefixes every validation message, e.g. `infra.costs.write`. */
  errorPrefix: string;
  /** Most rows accepted in one call. */
  maxRows: number;
}

/** Any tag key a caller may not set (we own this namespace). */
export const RESERVED_TAG_PREFIX = "infrawrench:";

/** Bounds. Pushed rows are user input; they must not be able to fill the table. */
export const MAX_TAGS_PER_ROW = 32;
export const MAX_FIELD_LENGTH = 256;

/** A rejected batch. Callers map this onto their own error surface. */
export class CostIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostIngestError";
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Za-z]{3}$/;

/** True for a `YYYY-MM-DD` string that is also a real calendar date. */
function isRealDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function shortString(value: unknown, fail: (detail: string) => never, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail(`has a non-string ${field}.`);
  if (value.length > MAX_FIELD_LENGTH) {
    fail(`has a ${field} longer than ${MAX_FIELD_LENGTH} characters.`);
  }
  return value;
}

function validateTags(raw: unknown, fail: (detail: string) => never): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) fail("has non-object tags.");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TAGS_PER_ROW) {
    fail(`has more than ${MAX_TAGS_PER_ROW} tags.`);
  }
  const tags: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.startsWith(RESERVED_TAG_PREFIX)) {
      fail(`uses the reserved tag key "${key}" (the "${RESERVED_TAG_PREFIX}" prefix is ours).`);
    }
    tags[shortString(key, fail, "tag key")] = shortString(value, fail, `tag "${key}"`);
  }
  return tags;
}

/**
 * Reject any `accountId` that is not a live account in this org — in one query,
 * and before anything is written, so a partial batch can't land.
 */
async function assertAccountsBelongToOrg(
  organizationId: string,
  rows: IngestCostRow[],
  errorPrefix: string,
): Promise<void> {
  const named = [...new Set(rows.map((r) => r?.accountId).filter((id): id is string => !!id))];
  if (named.length === 0) return;

  const found = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        isNull(accounts.deletedAt),
        inArray(accounts.id, named),
      ),
    );
  const known = new Set(found.map((a) => a.id));
  const unknown = named.find((id) => !known.has(id));
  if (unknown) {
    throw new CostIngestError(
      `${errorPrefix}: accountId "${unknown}" is not an account in this organization.`,
    );
  }
}

/**
 * Validate and store a batch of pushed cost rows. Throws
 * {@link CostIngestError} on anything the caller can fix; the message names the
 * offending row index and reaches the workflow author or the HTTP client.
 */
export async function ingestCostRows(opts: {
  organizationId: string;
  rows: IngestCostRow[];
  source: CostIngestSource;
}): Promise<{ written: number }> {
  const { organizationId, rows, source } = opts;

  if (!Array.isArray(rows)) throw new CostIngestError(`${source.errorPrefix} expects an array.`);
  if (rows.length === 0) return { written: 0 };
  if (rows.length > source.maxRows) {
    throw new CostIngestError(
      `${source.errorPrefix} accepts at most ${source.maxRows} rows per call (got ${rows.length}).`,
    );
  }
  if (!isClickHouseConfigured()) {
    throw new CostIngestError("Cost storage is not configured on this server.");
  }

  await assertAccountsBelongToOrg(organizationId, rows, source.errorPrefix);

  const mapped: CostDailyRow[] = rows.map((row, index) => {
    const fail = (detail: string): never => {
      throw new CostIngestError(`${source.errorPrefix}: row ${index} ${detail}`);
    };

    if (!row || typeof row !== "object") fail("is not an object.");
    if (!isRealDay(row.date)) fail(`has an invalid date "${row.date}" (expected YYYY-MM-DD).`);
    if (typeof row.currency !== "string" || !CURRENCY.test(row.currency)) {
      fail(`has an invalid currency "${row.currency}" (expected a 3-letter ISO code).`);
    }
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) {
      fail("has a non-finite amount.");
    }
    if (row.usageAmount !== undefined && !Number.isFinite(row.usageAmount)) {
      fail("has a non-finite usageAmount.");
    }

    // The reserved tag is what keeps this row's ReplacingMergeTree key disjoint
    // from anything a provider collector writes — see the module comment.
    const tags = { ...validateTags(row.tags, fail), [source.tag.key]: source.tag.value };

    return {
      organization_id: organizationId,
      account_id: row.accountId || source.fallbackAccountId,
      plugin_id: source.pluginId,
      day: row.date,
      service: shortString(row.service, fail, "service"),
      region: shortString(row.region, fail, "region"),
      resource_id: shortString(row.resourceId, fail, "resourceId"),
      tags,
      tags_hash: hashTags(tags),
      currency: row.currency.toUpperCase(),
      amount: row.amount,
      usage_amount: row.usageAmount ?? 0,
      usage_unit: shortString(row.usageUnit, fail, "usageUnit"),
      // Pushed rows are cash usage. A caller reporting a parsed invoice has no
      // provider-side notion of a commitment term to amortize over, and letting
      // them declare one would make "amortized" mean something different per
      // source. `hashTags` above is called without extras for the same reason:
      // these defaults must hash exactly as they did before the columns existed.
      charge_type: "usage",
      amortized_amount: 0,
      commitment_id: "",
    };
  });

  await insertCostRows(mapped);
  return { written: mapped.length };
}
