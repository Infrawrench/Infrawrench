/**
 * The poller's exchange-rate feed pass: fetch the ECB euro reference rates
 * and store them once for every org.
 *
 * One feed, one row of state (`fx_rate_feed_state`), claimed with the same
 * conditional-UPDATE lease the status-feed pass uses, so any number of poller
 * replicas run it without double-fetching. The first successful run loads the
 * full history since 1999 (the backfill); every later run loads the trailing
 * 90 days, which heals a missed week or a publisher correction without
 * re-downloading 8 MB.
 *
 * Failure is visible: the error lands on the state row, which the Currency
 * settings page and `GET /currency` show, and the pass retries hourly. A
 * failed fetch never deletes or overwrites stored rates, so conversion keeps
 * working on the last good data (and every converted figure names the
 * publication date it used, so staleness is on the page too).
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { fxRateFeedState } from "../db/schema";
import { fetchPublicFeedBody } from "../status/fetch-feed";
import {
  ECB_HISTORY_URL,
  ECB_RECENT_URL,
  ECB_SOURCE,
  nextFxFetchAt,
  parseEcbXml,
  type FxPublication,
} from "./fx-feed";
import { upsertFxPublications } from "./fx-feed-store";

/** Lease while a fetch is in flight: generous against the 120s timeout. */
const LEASE_MS = 10 * 60 * 1000;
/** Retry delay after a failed fetch. */
const RETRY_MS = 60 * 60 * 1000;
/**
 * The full history is ~8 MB and grows ~0.3 MB a year; the egress proxy caps
 * responses at 10 MB. Headroom for several years, after which the backfill
 * should move to the zipped CSV.
 */
const HISTORY_MAX_BYTES = 10 * 1024 * 1024;
const RECENT_MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_ERROR_LENGTH = 500;

/** Fetch a URL's XML: overridable in tests. */
export type FxFetcher = (url: string, maxBytes: number) => Promise<string>;

const defaultFetcher: FxFetcher = (url, maxBytes) =>
  fetchPublicFeedBody(url, {
    accept: "application/xml, text/xml;q=0.9, */*;q=0.5",
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes,
    label: "ECB reference-rate feed",
  });

/** Claim the feed if it is due. Returns whether it has been backfilled, or null. */
async function claimFeed(): Promise<{ backfilled: boolean } | null> {
  await db
    .insert(fxRateFeedState)
    .values({ source: ECB_SOURCE })
    .onConflictDoNothing({ target: fxRateFeedState.source });
  const rows = await db.execute(sql`
    UPDATE fx_rate_feed_state
    SET next_fetch_at = now() + ${LEASE_MS}::float8 * interval '1 millisecond',
        last_attempt_at = now(),
        updated_at = now()
    WHERE source = ${ECB_SOURCE} AND next_fetch_at <= now()
    RETURNING backfilled_at
  `);
  const claimed = Array.from(rows as Iterable<Record<string, unknown>>);
  if (claimed.length === 0) return null;
  return { backfilled: claimed[0]!["backfilled_at"] != null };
}

export interface FxFeedPassResult {
  claimed: boolean;
  backfill?: boolean;
  publications?: number;
  rows?: number;
  error?: string;
}

/**
 * Run one pass. A no-op (one cheap UPDATE matching nothing) on every tick
 * except the few each day when the feed is due.
 */
export async function runFxRateFeedPass(
  options: { fetcher?: FxFetcher; now?: () => Date } = {},
): Promise<FxFeedPassResult> {
  const fetcher = options.fetcher ?? defaultFetcher;
  const now = options.now ?? (() => new Date());

  const claim = await claimFeed();
  if (!claim) return { claimed: false };

  const backfill = !claim.backfilled;
  try {
    const xml = backfill
      ? await fetcher(ECB_HISTORY_URL, HISTORY_MAX_BYTES)
      : await fetcher(ECB_RECENT_URL, RECENT_MAX_BYTES);
    const publications: FxPublication[] = parseEcbXml(xml);
    const rows = await upsertFxPublications(publications, ECB_SOURCE);

    const newest = publications[publications.length - 1]!;
    const oldest = publications[0]!;
    const finishedAt = now();
    const [state] = await db
      .select({
        latestRateDate: fxRateFeedState.latestRateDate,
        earliestRateDate: fxRateFeedState.earliestRateDate,
      })
      .from(fxRateFeedState)
      .where(eq(fxRateFeedState.source, ECB_SOURCE));
    const latest =
      state?.latestRateDate && state.latestRateDate > newest.date
        ? state.latestRateDate
        : newest.date;
    const earliest =
      state?.earliestRateDate && state.earliestRateDate < oldest.date
        ? state.earliestRateDate
        : oldest.date;

    await db
      .update(fxRateFeedState)
      .set({
        nextFetchAt: nextFxFetchAt(finishedAt, latest),
        lastSuccessAt: finishedAt,
        lastError: null,
        latestRateDate: latest,
        earliestRateDate: earliest,
        // Only move the coverage list forward: a 90-day file is newest-last
        // like the history, so its newest publication is the current one.
        ...(newest.date === latest ? { currencies: Object.keys(newest.rates).sort() } : {}),
        ...(backfill ? { backfilledAt: finishedAt } : {}),
        updatedAt: finishedAt,
      })
      .where(eq(fxRateFeedState.source, ECB_SOURCE));

    console.log(
      `[fx-feed] stored ${rows} rates from ${publications.length} ECB publications (${oldest.date}..${newest.date}${backfill ? ", backfill" : ""})`,
    );
    return { claimed: true, backfill, publications: publications.length, rows };
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_LENGTH);
    console.error(
      `[fx-feed] ECB reference-rate fetch failed (${backfill ? "backfill" : "daily"}):`,
      e,
    );
    await db
      .update(fxRateFeedState)
      .set({
        nextFetchAt: new Date(now().getTime() + RETRY_MS),
        lastError: message,
        updatedAt: now(),
      })
      .where(eq(fxRateFeedState.source, ECB_SOURCE));
    return { claimed: true, backfill, error: message };
  }
}
