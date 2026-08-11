/**
 * Superseded-row reconciliation for cost collection.
 *
 * ─── The hazard ───────────────────────────────────────────────────────────
 *
 * `cost_daily` is a ReplacingMergeTree. Re-collecting a day *replaces* a row
 * only when the new row lands on the same sort key; a row nothing rewrites is
 * never deleted, because a ReplacingMergeTree has no concept of deletion. That
 * key is frozen (see `migrate.ts`) and cannot carry charge type or commitment
 * id, so `cost-writers.ts` folds those into `tags_hash` — but only when they
 * are non-default, precisely so an ordinary usage row keeps hashing the way it
 * always did.
 *
 * The consequence bites the day a plugin *starts* attributing. A
 * `(day, service, region)` cell that used to be one undifferentiated row —
 * usage plus tax plus a reservation fee, summed by an unfiltered query — now
 * arrives as a usage row at the *same* hash plus attribution rows at *new*
 * hashes. Cells containing any consumption re-state correctly, because the
 * usage row supersedes the old one. A cell whose spend was **entirely**
 * non-usage does not: nothing is written at its old key any more, the stale row
 * survives, and the day reads high by whatever that cell held.
 *
 * The same shape recurs for reasons that have nothing to do with charge types:
 * a provider restating a cell's spend away, a service or region label changing,
 * a plugin gaining the `resource` dimension. It is generic, so it is solved
 * here, once, rather than hand-rolled per plugin — and hand-rolling it in a
 * plugin cannot work in general anyway, because a plugin only knows the keys it
 * is *writing*, not the keys already stored under labels it no longer emits.
 *
 * ─── The mechanism ────────────────────────────────────────────────────────
 *
 * After a chunk is fetched and before it is inserted, read back the keys
 * already stored for this account over the chunk's day range, subtract the keys
 * about to be written, and write a **zero-amount row at each key left over**.
 * Same key, so it replaces rather than adds; the money becomes nothing, which
 * is what the provider now says it is.
 *
 * Zeroing rather than `ALTER TABLE ... DELETE` is deliberate. A mutation is
 * asynchronous, rewrites whole parts, and is the kind of thing an operator has
 * to be told to run — which was the resting state this module exists to remove.
 * An insert on an existing key is the table's own supersede path, costs one row,
 * and lands with the collection that noticed it.
 *
 * ─── What it does not fix ─────────────────────────────────────────────────
 *
 * It repairs a key that moved *under a day the collection restates*, which is
 * the whole of the charge-type hazard above and most restatement shapes. A day
 * no collection ever covers again — one that has aged out of the plugin's
 * restatement window — is beyond it, and stays wrong until a re-backfill covers
 * it. Choosing a restatement window wide enough to reach a plugin's own
 * dating unit is therefore part of the plugin's job, not this module's.
 *
 * ─── When it must not fire ────────────────────────────────────────────────
 *
 * Four guards, each protecting against a way this could destroy real data.
 * Three are here; the fourth is the caller's, because only a plugin can know
 * it — see `cost/collect.ts` and `CostFetchResult.degraded`, which suppresses
 * reconciliation for a pass that fell back to a coarser key space than usual.
 *
 * 1. **Nothing written, nothing zeroed.** A chunk the plugin returned no rows
 *    for is left completely alone. A provider that errors into an empty result,
 *    a billing export that has not caught up yet, a partition that returns
 *    nothing for a window it has not finished computing — none of those are
 *    evidence that the stored spend is wrong.
 * 2. **Only days the plugin restated.** Within a chunk, a stored row is a
 *    candidate only if the plugin restated *that day*. A day the provider
 *    skipped entirely is not a day it restated to zero. This is what keeps a
 *    provider that reports the last 24h late from wiping yesterday. The
 *    intra-day hazard costs nothing here — the stale cell always sits on a day
 *    that has other, healthy cells.
 *
 *    "Restated" is a day the plugin wrote to, **plus**, for a period-native
 *    plugin that wrote a row dated to the 1st of a month, the rest of that
 *    calendar month. A monthly-native plugin files a whole month on one day, so
 *    the day rule alone would leave anything stored in the interior standing
 *    forever — which is precisely how a month once dated to a *moving* day
 *    inside itself (an in-progress total clamped to the requested range, as
 *    Mistral's collector did) stays inflated after the dating is fixed. The
 *    rule, and why it is the 1st rather than any written day, lives in
 *    `cost/period-scope.ts`.
 * 3. **Only this plugin's own rows.** Rows pushed through the ingest API
 *    (`cost/cost-ingest.ts`) are written under their own `plugin_id` and carry
 *    a reserved `infrawrench:`-prefixed tag; both are excluded. A collector must
 *    never zero spend a user pushed, and vice versa.
 *
 *    **This guard depends on a property of `cost-writers.ts` that is invisible
 *    from here**: `hashTags` folds its synthetic `infrawrench:charge_type` and
 *    `infrawrench:commitment` entries into `tags_hash` *without* writing them
 *    into the `tags` column. If it ever stored them, every attribution row a
 *    collector writes would carry a reserved key, this guard would skip all of
 *    them, and reconciliation would silently do nothing for the exact rows it
 *    exists to fix. The coupling is called out at both ends; do not "fix" the
 *    asymmetry in either place alone.
 */
import { restatedDayScope } from "../cost/period-scope";
import { getClickHouseClient, isClickHouseConfigured } from "./client";
import { DAY_FROM_SQL, DAY_TO_SQL } from "./cost-readers";
import type { CostDailyRow } from "./cost-writers";

/** Mirrors `cost/cost-ingest.ts`'s `RESERVED_TAG_PREFIX`; see guard 3 above. */
const RESERVED_KEY_PREFIX = "infrawrench:";

/**
 * What the collecting plugin says about the shape of its own rows. Only
 * `periodNative` matters here, and only to guard 2 — see `cost/period-scope.ts`.
 */
export interface ReconcileOptions {
  periodNative?: boolean | undefined;
}

/**
 * A stored row's identity plus the non-key columns a tombstone has to carry
 * forward. `charge_type` and `commitment_id` are copied verbatim rather than
 * defaulted: they are folded into `tags_hash`, so a tombstone that changed them
 * would describe a row whose hash no longer matches its own contents.
 */
export interface StoredCostRowKey {
  day: string;
  service: string;
  region: string;
  resource_id: string;
  tags: Record<string, string>;
  tags_hash: string;
  currency: string;
  charge_type: string;
  commitment_id: string;
}

/** The full ReplacingMergeTree identity of a row, minus org/account/plugin. */
function identity(row: {
  day: string;
  service: string;
  region: string;
  resource_id: string;
  tags_hash: string;
  currency: string;
}): string {
  // NUL-joined: service names carry spaces and dashes ("Amazon Elastic Compute
  // Cloud - Compute"), and a printable separator would let ("A B", region "C")
  // collide with ("A", region "B C").
  return [row.day, row.service, row.region, row.resource_id, row.tags_hash, row.currency].join(
    "\u0000",
  );
}

/**
 * The zero-amount rows that supersede everything stored for this account in the
 * window that the collection is not rewriting. **Pure** — the query and the
 * insert live in {@link reconcileCollectedChunk}; this is the part worth
 * testing exhaustively.
 *
 * See the module header for why each guard is here.
 */
export function supersededTombstones(
  meta: { organizationId: string; accountId: string; pluginId: string },
  stored: StoredCostRowKey[],
  written: CostDailyRow[],
  options?: ReconcileOptions,
): CostDailyRow[] {
  // Guard 1: a chunk that produced nothing is not evidence of anything.
  if (written.length === 0) return [];

  const writtenKeys = new Set(written.map(identity));
  // Guard 2: only days this collection actually restated — which for a
  // period-native plugin means the period, not just the day it filed it on.
  const restated = restatedDayScope(
    written.map((r) => r.day),
    options,
  );

  const tombstones = new Map<string, CostDailyRow>();
  for (const row of stored) {
    if (!restated.has(row.day)) continue;
    const key = identity(row);
    if (writtenKeys.has(key)) continue;
    // Guard 3, second half: never zero a pushed row that slipped through the
    // query's plugin_id filter (an ingest source sharing a plugin id).
    //
    // Only *pushed* rows can match: a collector's attribution rows fold their
    // reserved keys into `tags_hash` and leave the `tags` column alone. See the
    // module header — that asymmetry is what keeps this from skipping every row
    // reconciliation is for.
    if (Object.keys(row.tags).some((k) => k.startsWith(RESERVED_KEY_PREFIX))) continue;
    if (tombstones.has(key)) continue;
    tombstones.set(key, {
      organization_id: meta.organizationId,
      account_id: meta.accountId,
      plugin_id: meta.pluginId,
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
      // Not "amortized to zero" — this row has no money on any basis, and the
      // amortized reader's fallback to `amount` finds zero either way.
      amortized_reported: 0,
      commitment_id: row.commitment_id,
    });
  }
  return [...tombstones.values()];
}

/**
 * Read back the keys this account already has stored over `[from, to]` that
 * still hold money.
 *
 * `FINAL` because an un-merged part can hold several versions of one key and a
 * tombstone per version would be pointless duplication;
 * {@link supersededTombstones} de-duplicates as well, since `FINAL` is a read
 * guarantee rather than a uniqueness one.
 *
 * **Rows that are already zero on both bases are excluded, and that is what
 * makes a key get tombstoned once rather than forever.** Without the filter a
 * superseded key comes back on the next collection looking exactly like a
 * candidate again — it is still stored, and the collection still does not
 * write it — so every subsequent collection of that day would re-emit an
 * identical zero row. The insert is idempotent, so nothing is *wrong*; it is
 * simply unbounded write amplification against the one table where retaining
 * years of daily history is the point. A key zeroed once is done.
 *
 * `usage_amount` is deliberately not in the predicate: a tombstone zeroes it
 * too, so a row with no money and no quantity is fully superseded, and a row
 * that somehow kept a quantity without an amount is not spend anyone reads.
 *
 * Cardinality is bounded by what the same account's collection returns for the
 * same window, which the caller already holds in memory — so this adds a query
 * per chunk, not a scaling problem.
 */
export async function getStoredCostRowKeys(
  meta: { organizationId: string; accountId: string; pluginId: string },
  from: string,
  to: string,
): Promise<StoredCostRowKey[]> {
  if (!isClickHouseConfigured()) return [];
  const rs = await getClickHouseClient().query({
    query: `SELECT toString(day) AS day, service, region, resource_id, tags,
                   toString(tags_hash) AS tags_hash, currency, charge_type, commitment_id
            FROM cost_daily FINAL
            WHERE organization_id = {orgId:String}
              AND account_id = {accountId:String}
              AND plugin_id = {pluginId:String}
              AND ${DAY_FROM_SQL}
              AND ${DAY_TO_SQL}
              AND (amount != 0 OR amortized_amount != 0)`,
    query_params: {
      orgId: meta.organizationId,
      accountId: meta.accountId,
      pluginId: meta.pluginId,
      from,
      to,
    },
    format: "JSONEachRow",
  });
  return await rs.json<StoredCostRowKey>();
}

/**
 * One chunk's tombstones: read the stored keys, subtract what is about to be
 * written, and hand back the zero rows to insert alongside it.
 *
 * Returns `[]` — without querying — for a chunk that produced no rows, so a
 * failed or empty fetch can never take existing data with it.
 */
export async function reconcileCollectedChunk(
  meta: { organizationId: string; accountId: string; pluginId: string },
  range: { fromDate: string; toDate: string },
  written: CostDailyRow[],
  options?: ReconcileOptions,
): Promise<CostDailyRow[]> {
  if (written.length === 0) return [];
  const stored = await getStoredCostRowKeys(meta, range.fromDate, range.toDate);
  return supersededTombstones(meta, stored, written, options);
}
