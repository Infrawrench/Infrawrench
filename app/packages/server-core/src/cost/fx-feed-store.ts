/**
 * Postgres side of the automatic exchange-rate feed: reading the stored
 * history into an in-memory snapshot, reporting the feed's health, and
 * writing publications. The rules for *using* a snapshot are in the pure
 * `./fx-feed.ts`; the poller pass that fills the table is `./fx-feed-pass.ts`.
 *
 * ## The snapshot cache
 *
 * Every converted cost query in an org with automatic rates on needs the
 * feed, and the feed changes once a day. So each process holds one snapshot
 * of the whole history (under 2 MB, see `FxFeedSnapshot`) and reloads it at
 * most every `SNAPSHOT_TTL_MS`. The load is a single grouped query returning
 * one row per publication day (~7,000 rows), not one per rate. Concurrent
 * callers share one in-flight load.
 */
import { eq, sql } from "drizzle-orm";
import type { FxFeedStatus } from "@infrawrench/client-core";
import { db } from "../db/client";
import { fxRateFeedState, fxReferenceRates } from "../db/schema";
import {
  buildFxFeedSnapshot,
  ECB_SOURCE,
  ECB_SOURCE_NAME,
  ECB_SOURCE_URL,
  type FxFeedSnapshot,
  type FxPublication,
} from "./fx-feed";

/** How stale a process's snapshot may get before it reloads. */
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;

let cached: { snapshot: FxFeedSnapshot; loadedAt: number } | null = null;
let inflight: Promise<FxFeedSnapshot> | null = null;

/** Drop the cached snapshot (after a write, and between tests). */
export function invalidateFxFeedSnapshot(): void {
  cached = null;
}

async function loadSnapshot(): Promise<FxFeedSnapshot> {
  // One row per publication day: `USD=1.1225,JPY=176.99,...`. Grouping in SQL
  // keeps the transfer to ~7,000 short rows instead of ~200,000 drizzle
  // objects, which is the difference between a cheap reload and a GC pause.
  const rows = await db.execute(sql`
    SELECT to_char(rate_date, 'YYYY-MM-DD') AS d,
           string_agg(currency || '=' || per_eur::text, ',') AS r
    FROM fx_reference_rates
    WHERE source = ${ECB_SOURCE}
    GROUP BY rate_date
    ORDER BY rate_date
  `);
  const list = Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    d: String(r["d"]),
    r: String(r["r"] ?? ""),
  }));
  const publications: FxPublication[] = list.map((row) => {
    const rates: Record<string, string> = {};
    for (const pair of row.r.split(",")) {
      const [code, value] = pair.split("=");
      if (code && value) rates[code] = value;
    }
    return { date: row.d, rates };
  });
  return buildFxFeedSnapshot(publications);
}

/**
 * The whole feed history, cached per process. An empty snapshot (no rows yet,
 * before the first poller run) is a valid answer: every lookup returns null
 * and conversion reports the currencies unconverted, which is honest.
 */
export async function getFxFeedSnapshot(now = Date.now()): Promise<FxFeedSnapshot> {
  if (cached && now - cached.loadedAt < SNAPSHOT_TTL_MS) return cached.snapshot;
  if (!inflight) {
    inflight = loadSnapshot()
      .then((snapshot) => {
        cached = { snapshot, loadedAt: Date.now() };
        return snapshot;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** The feed's health and coverage, for the settings page and the API. */
export async function getFxFeedStatus(): Promise<FxFeedStatus> {
  const [row] = await db
    .select()
    .from(fxRateFeedState)
    .where(eq(fxRateFeedState.source, ECB_SOURCE));
  const currencies = Array.isArray(row?.currencies) ? [...row.currencies] : [];
  return {
    source: ECB_SOURCE,
    sourceName: ECB_SOURCE_NAME,
    sourceUrl: ECB_SOURCE_URL,
    latestRateDate: row?.latestRateDate ?? null,
    earliestRateDate: row?.earliestRateDate ?? null,
    currencies: currencies.length > 0 ? [...new Set([...currencies, "EUR"])].sort() : [],
    lastSuccessAt: row?.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
    lastError: row?.lastError ?? null,
  };
}

/** Rows per INSERT: 2,000 rows x 4 params stays far under Postgres's 65,535. */
const UPSERT_CHUNK = 2000;

/**
 * Store publications, replacing any value already held for the same day and
 * currency (the ECB occasionally corrects a recent publication). Returns the
 * number of rate rows written.
 */
export async function upsertFxPublications(
  publications: readonly FxPublication[],
  source: string = ECB_SOURCE,
): Promise<number> {
  const rows = publications.flatMap((p) =>
    Object.entries(p.rates)
      .filter(([currency]) => currency !== "EUR")
      .map(([currency, perEur]) => ({ source, rateDate: p.date, currency, perEur })),
  );
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await db
      .insert(fxReferenceRates)
      .values(rows.slice(i, i + UPSERT_CHUNK))
      .onConflictDoUpdate({
        target: [fxReferenceRates.source, fxReferenceRates.rateDate, fxReferenceRates.currency],
        set: { perEur: sql`excluded.per_eur` },
      });
  }
  invalidateFxFeedSnapshot();
  return rows.length;
}
