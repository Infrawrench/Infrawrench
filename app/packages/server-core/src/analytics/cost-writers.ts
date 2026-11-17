import type { CostChargeType, CostRow } from "@infrawrench/plugin-base";
import { getTableColumns, sql, type InferInsertModel, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { getAnalyticsDb } from "./client";
import { costDaily, type Complete } from "./schema";

/**
 * A `cost_daily` row as the collectors and the ingest API build one.
 *
 * Derived from the table rather than restated, so a column added to `schema.ts`
 * is a column every producer of this type has to fill. `ingested_at` is dropped
 * because the server's `now()` default owns it; everything else is required:
 * see {@link Complete}.
 */
export type CostDailyRow = Complete<Omit<InferInsertModel<typeof costDaily>, "ingested_at">>;

/**
 * Tag keys the host owns. Mirrors `RESERVED_TAG_PREFIX` in `cost/cost-ingest.ts`
 * (restated rather than imported: that module imports this one, and a cycle
 * between the writer and its validator helps nobody). Pushed rows are rejected
 * for using this prefix, so nothing a caller supplies can collide with the
 * synthetic entries {@link hashTags} folds in below.
 */
const RESERVED_KEY_PREFIX = "infrawrench:";

/**
 * The parts of a row's identity that are NOT columns in `cost_daily`'s primary
 * key but must still keep rows apart. See {@link hashTags}.
 */
export interface CostRowKeyExtras {
  chargeType?: string | undefined;
  commitmentId?: string | undefined;
}

/**
 * Stable 64-bit FNV-1a hash of a canonicalized (key-sorted, `=`/`\n`-joined)
 * tags map, as a decimal string (Postgres has no unsigned 64-bit integer, and
 * nothing does arithmetic on it). Deterministic across processes so a
 * re-ingested row lands on the same primary key and replaces the one stored.
 *
 * **Why charge type and commitment id are hashed in here.** `cost_daily`'s
 * primary key is
 * `(org, account, day, service, region, resource_id, tags_hash, currency)`, and
 * that key is frozen: it cannot gain `charge_type` without re-keying three
 * years of history. But a provider legitimately reports several charge types
 * for the same account, day, service and region: the EC2 usage line, the credit
 * applied against it, and the tax on it are three rows identical in every key
 * column. Written as-is, the upsert would treat them as three versions of one
 * row and keep only the last one written: the org's spend would silently
 * become whichever line the provider happened to page in last.
 *
 * So they are folded into `tags_hash`, which IS in the key, as synthetic
 * `infrawrench:`-prefixed entries. This is the same trick pushed rows use to
 * keep their key space disjoint from the collectors' (`cost/cost-ingest.ts`),
 * for the same reason.
 *
 * **The fold is conditional, and that is not an optimization.** A row with no
 * charge type (or an explicit `usage`) and no commitment id hashes to exactly
 * what it hashed to before this field existed. That is what makes re-collecting
 * a day *replace* the rows already stored for it instead of doubling every
 * historical number the first time a restatement window is re-fetched. Do not
 * "simplify" this by always appending the charge type.
 *
 * **The synthetic entries go into the hash only (never into the `tags` column
 * {@link toCostDailyRows} writes) and something depends on that.**
 * `analytics/cost-reconcile.ts` distinguishes a collector's rows from rows a
 * user pushed by looking for a reserved key in the *stored* `tags`, so if these
 * entries were also stored, every attribution row a collector writes would look
 * pushed, and reconciliation would skip exactly the rows it exists to fix:
 * silently, since it would still run and still find nothing. The two ends are
 * cross-referenced; change neither alone.
 */
export function hashTags(
  tags: Record<string, string> | undefined,
  extras?: CostRowKeyExtras,
): string {
  const keys = tags ? Object.keys(tags).sort() : [];
  const parts = keys.map((k) => `${k}=${tags![k]}`);

  // Only non-default values are folded in: see the note above about why the
  // default must hash identically to a plain tags map.
  const chargeType = extras?.chargeType ?? "usage";
  if (chargeType !== "usage") parts.push(`${RESERVED_KEY_PREFIX}charge_type=${chargeType}`);
  const commitmentId = extras?.commitmentId ?? "";
  if (commitmentId) parts.push(`${RESERVED_KEY_PREFIX}commitment=${commitmentId}`);

  if (parts.length === 0) return "0";
  const canonical = parts.join("\n");
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(10);
}

/** Map one plugin CostRow onto a cost_daily row. */
function toCostDailyRow(
  meta: { organizationId: string; accountId: string; pluginId: string },
  r: CostRow,
): CostDailyRow {
  const chargeType: CostChargeType = r.chargeType ?? "usage";
  const commitmentId = r.commitmentId ?? "";
  return {
    organization_id: meta.organizationId,
    account_id: meta.accountId,
    plugin_id: meta.pluginId,
    day: r.date,
    service: r.service ?? "",
    region: r.region ?? "",
    resource_id: r.resourceId ?? "",
    tags: r.tags ?? {},
    // Charge type and commitment id ride in the hash because the primary key
    // cannot carry them: without this a credit would replace the usage line
    // it was credited against. See hashTags.
    tags_hash: hashTags(r.tags, { chargeType, commitmentId }),
    currency: r.currency,
    amount: r.amount,
    usage_amount: r.usageAmount ?? 0,
    usage_unit: r.usageUnit ?? "",
    charge_type: chargeType,
    // Absent and zero are different answers and must stay different: a
    // commitment purchase amortizes to *zero* on its purchase day, while a
    // provider with no amortized data at all has *no* answer and readers fall
    // back to `amount`. Collapsing the two shows the purchase at full cash
    // alongside all of its amortized slices.
    amortized_amount: r.amortizedAmount ?? 0,
    amortized_reported: r.amortizedAmount === undefined ? 0 : 1,
    commitment_id: commitmentId,
    // Absent and zero differ here too: free-tier usage lists at zero, while a
    // provider with no list price leaves the line to the fallback uplift.
    list_amount: r.listAmount ?? 0,
    list_reported: r.listAmount === undefined ? 0 : 1,
    // Same absent-versus-zero discipline: an unreported blended amount falls
    // back to the amortized one, a reported zero is a real share.
    blended_amount: r.blendedAmount ?? 0,
    blended_reported: r.blendedAmount === undefined ? 0 : 1,
  };
}

/** Map plugin CostRows onto cost_daily rows for one account. */
export function toCostDailyRows(
  meta: { organizationId: string; accountId: string; pluginId: string },
  rows: CostRow[],
): CostDailyRow[] {
  return rows.map((r) => toCostDailyRow(meta, r));
}

/**
 * Rows per statement. Postgres caps a statement at 65,535 bind parameters and a
 * row binds one per column (21 of them), so this stays well inside the cap
 * while keeping a month of resource-level billing to a handful of round trips.
 */
const INSERT_BATCH_ROWS = 1000;

/** `cost_daily`'s primary key, in declaration order. */
const KEY_COLUMNS: PgColumn[] = [
  costDaily.organization_id,
  costDaily.account_id,
  costDaily.day,
  costDaily.service,
  costDaily.region,
  costDaily.resource_id,
  costDaily.tags_hash,
  costDaily.currency,
];

/**
 * The upsert's `SET`: every column outside the key takes the incoming row's
 * value. Derived from the table so a column added to the schema is replaced on
 * a re-fetch too, rather than silently keeping its first value forever.
 */
const REPLACE_NON_KEY_COLUMNS: Record<string, SQL> = Object.fromEntries(
  Object.entries(getTableColumns(costDaily))
    .filter(([, column]) => !KEY_COLUMNS.includes(column))
    .map(([property, column]) => [property, sql`excluded.${sql.identifier(column.name)}`]),
);

/** A row's primary key, NUL-joined so no two distinct keys collide. */
function primaryKey(row: CostDailyRow): string {
  return [
    row.organization_id,
    row.account_id,
    row.day,
    row.service,
    row.region,
    row.resource_id,
    row.tags_hash,
    row.currency,
  ].join("\u0000");
}

/**
 * Write a chunk's rows: an upsert on the primary key that replaces every
 * non-key column, so re-fetching a day restates it in place.
 *
 * A stored row is only replaced by one with an `ingested_at` at least as new.
 * Every write stamps the database's `now()`, so in practice the latest write
 * wins; the guard keeps two collections of the same account racing each other
 * from leaving the older fetch's numbers behind.
 *
 * Postgres refuses a statement that touches the same key twice ("cannot affect
 * row a second time"), so each batch keeps only the last row per key, the one
 * that would have replaced the others anyway. Batches run in one transaction,
 * so a reader never sees a chunk half restated.
 *
 * Unlike the fire-and-forget metric writers, cost collection must know about
 * failures so the poller can back off and retry: errors throw.
 *
 * **Accepts an async iterable, and nothing here passes one.** Rows are written
 * a batch at a time, so a caller producing them lazily would never hold a month
 * of a large account's resource-level billing at once, but `cost/collect.ts`
 * cannot be that caller. Reconciliation subtracts the keys about to be written
 * from the keys already stored, and appends its tombstones to the same write,
 * so the mapped rows have to exist before the write starts. The parameter is
 * here so that a shape which *can* stream does not have to reopen this
 * function.
 */
export async function insertCostRows(
  rows: CostDailyRow[] | AsyncIterable<CostDailyRow>,
): Promise<void> {
  if (Array.isArray(rows) && rows.length === 0) return;
  await getAnalyticsDb().transaction(async (tx) => {
    const flush = async (batch: Map<string, CostDailyRow>): Promise<void> => {
      if (batch.size === 0) return;
      await tx
        .insert(costDaily)
        .values([...batch.values()])
        .onConflictDoUpdate({
          target: KEY_COLUMNS,
          set: REPLACE_NON_KEY_COLUMNS,
          setWhere: sql`${costDaily.ingested_at} <= excluded.ingested_at`,
        });
    };

    let batch = new Map<string, CostDailyRow>();
    for await (const row of rows) {
      const key = primaryKey(row);
      // Deleted first so the surviving row moves to the end, keeping the batch
      // in the order the rows arrived in.
      batch.delete(key);
      batch.set(key, row);
      if (batch.size >= INSERT_BATCH_ROWS) {
        await flush(batch);
        batch = new Map();
      }
    }
    await flush(batch);
  });
}
