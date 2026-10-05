/**
 * Validation and storage for cost rows Infrawrench did not collect itself.
 *
 * Two callers push spend this way and they must behave identically, so the
 * rules live here rather than in either of them:
 *
 * - `cost/workflow-costs.ts`: a workflow calling `infra.costs.write(...)`.
 * - `cost/external-costs.ts`: a server calling `POST /costs/rows`.
 *
 * **Why every pushed row carries a reserved tag.** `cost_daily` is a
 * ReplacingMergeTree keyed on
 * `(org, account, day, service, region, resource_id, tags_hash, currency)`:
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
import { COST_CHARGE_TYPES } from "@infrawrench/client-core";

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
  /**
   * The file's own account label (custom cost sources only, see
   * {@link CostIngestSource.subAccountId}). Never an Infrawrench account id.
   */
  subAccount?: string | undefined;
  /** Charge attribution: honoured only when the source sets `allowAttribution`. */
  chargeType?: string | undefined;
  amortizedAmount?: number | undefined;
  commitmentId?: string | undefined;
}

/** Where a batch of pushed rows came from, and how to key it. */
export interface CostIngestSource {
  /** `plugin_id` on every row: the value the "provider" dimension shows. */
  pluginId: string;
  /**
   * Reserved tag stamped on every row. Its value is what keeps this source's
   * ReplacingMergeTree key space disjoint from the pollers': see the module
   * comment. The key must start with {@link RESERVED_TAG_PREFIX}.
   */
  tag: { key: string; value: string };
  /** `account_id` for rows that name no real account. */
  fallbackAccountId: string;
  /** Prefixes every validation message, e.g. `infra.costs.write`. */
  errorPrefix: string;
  /** Most rows accepted in one call. */
  maxRows: number;
  /**
   * Accept `chargeType`, `amortizedAmount` and `commitmentId`. Only custom
   * cost sources set this: a FOCUS file states its charge categories and
   * amortized cost, which an API push has no standard way to. Off, those
   * fields are ignored exactly as they always were.
   */
  allowAttribution?: boolean | undefined;
  /**
   * Map a row's `subAccount` onto a synthetic account id. Set, `accountId` is
   * rejected (a source's rows never claim a real account) and `subAccount`
   * splits the account dimension instead.
   */
  subAccountId?: ((subAccount: string) => string) | undefined;
  /** Inclusive range every row's date must fall in (an upload's declared range). */
  dateRange?: { from: string; to: string } | undefined;
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
const CHARGE_TYPES: ReadonlySet<string> = new Set(COST_CHARGE_TYPES);
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
 * Reject any `accountId` that is not a live account in this org: in one query,
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
  const mapped = await validateCostRows(opts);
  if (mapped.length > 0) await insertCostRows(mapped);
  return { written: mapped.length };
}

/**
 * The validation half of {@link ingestCostRows}: every check, nothing written.
 * Custom cost uploads call this directly so they can total the rows before
 * inserting them.
 */
export async function validateCostRows(opts: {
  organizationId: string;
  rows: IngestCostRow[];
  source: CostIngestSource;
}): Promise<CostDailyRow[]> {
  const { organizationId, rows, source } = opts;

  if (!Array.isArray(rows)) throw new CostIngestError(`${source.errorPrefix} expects an array.`);
  if (rows.length === 0) return [];
  if (rows.length > source.maxRows) {
    throw new CostIngestError(
      `${source.errorPrefix} accepts at most ${source.maxRows} rows per call (got ${rows.length}).`,
    );
  }
  if (!isClickHouseConfigured()) {
    throw new CostIngestError("Cost storage is not configured on this server.");
  }

  if (source.subAccountId) {
    const index = rows.findIndex((r) => r && typeof r === "object" && r.accountId);
    if (index !== -1) {
      throw new CostIngestError(
        `${source.errorPrefix}: row ${index} sets accountId; use subAccount for the file's own account label.`,
      );
    }
  } else {
    await assertAccountsBelongToOrg(organizationId, rows, source.errorPrefix);
  }

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
    if (source.dateRange && (row.date < source.dateRange.from || row.date > source.dateRange.to)) {
      fail(
        `has date ${row.date} outside the upload's range ${source.dateRange.from} to ${source.dateRange.to}.`,
      );
    }

    let chargeType = "usage";
    let commitmentId = "";
    let amortizedAmount = 0;
    let amortizedReported = 0;
    if (source.allowAttribution) {
      if (row.chargeType !== undefined && row.chargeType !== null) {
        if (typeof row.chargeType !== "string" || !CHARGE_TYPES.has(row.chargeType)) {
          fail(`has an unknown chargeType "${String(row.chargeType)}".`);
        }
        chargeType = row.chargeType;
      }
      commitmentId = shortString(row.commitmentId, fail, "commitmentId");
      if (row.amortizedAmount !== undefined && row.amortizedAmount !== null) {
        if (typeof row.amortizedAmount !== "number" || !Number.isFinite(row.amortizedAmount)) {
          fail("has a non-finite amortizedAmount.");
        }
        amortizedAmount = row.amortizedAmount;
        amortizedReported = 1;
      }
    }
    const subAccount = source.subAccountId ? shortString(row.subAccount, fail, "subAccount") : "";
    const accountId = source.subAccountId
      ? subAccount
        ? source.subAccountId(subAccount)
        : source.fallbackAccountId
      : row.accountId || source.fallbackAccountId;

    // The reserved tag is what keeps this row's ReplacingMergeTree key disjoint
    // from anything a provider collector writes: see the module comment.
    const tags = { ...validateTags(row.tags, fail), [source.tag.key]: source.tag.value };

    return {
      organization_id: organizationId,
      account_id: accountId,
      plugin_id: source.pluginId,
      day: row.date,
      service: shortString(row.service, fail, "service"),
      region: shortString(row.region, fail, "region"),
      resource_id: shortString(row.resourceId, fail, "resourceId"),
      tags,
      // Without attribution the extras are the defaults, which hash exactly as
      // a plain tags map: see `hashTags`.
      tags_hash: hashTags(tags, { chargeType, commitmentId }),
      currency: row.currency.toUpperCase(),
      amount: row.amount,
      usage_amount: row.usageAmount ?? 0,
      usage_unit: shortString(row.usageUnit, fail, "usageUnit"),
      // API-pushed and workflow rows are cash usage. A caller reporting a parsed
      // invoice has no provider-side notion of a commitment term to amortize
      // over, and letting them declare one would make "amortized" mean
      // something different per source. A FOCUS upload is the exception (see
      // `allowAttribution`): the spec defines both columns. Defaults hash
      // exactly as they did before the columns existed.
      charge_type: chargeType as CostDailyRow["charge_type"],
      amortized_amount: amortizedAmount,
      // Not reported, not "reported as zero": an amortized query falls back to
      // the cash amount for these rows rather than showing them as worthless.
      amortized_reported: amortizedReported,
      commitment_id: commitmentId,
      // A pushed or uploaded row carries no list price; re-rating falls back
      // to the uplift.
      list_amount: 0,
      list_reported: 0,
      // No blended share is computed for pushed or uploaded rows: blended
      // readers fall back to the amortized amount (an uploaded FOCUS
      // EffectiveCost, or cash), which is what the row already states.
      blended_amount: 0,
      blended_reported: 0,
    };
  });

  return mapped;
}
