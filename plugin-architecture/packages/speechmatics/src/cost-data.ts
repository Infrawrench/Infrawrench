/**
 * Estimated-spend collection from Speechmatics' batch usage endpoint.
 *
 * `GET https://{region}.asr.api.speechmatics.com/v2/usage?since=&until=`
 * (https://docs.speechmatics.com/api-ref/batch/get-usage-statistics, schema in
 * https://docs.speechmatics.com/batch.yaml) returns
 * `{since, until, summary[], details[]}`, where each entry is
 * `{mode, type, language, operating_point, count, duration_hrs}`.
 *
 * Two things about that shape drive everything below.
 *
 * 1. **It reports hours, not money.** Speechmatics has no billing API — the
 *    only number available is metered audio duration, so the amounts here are
 *    `duration_hrs × published list rate` (see {@link RATE_CARD}). The manifest
 *    declares `estimated: true` for exactly this reason.
 *
 * 2. **It has no daily buckets.** `since`/`until` describe one window and the
 *    response aggregates the whole of it; there is no granularity parameter and
 *    no per-day array. A daily cost row therefore means one request per day,
 *    which is why this module is mostly a paced, backoff-aware request loop
 *    rather than a single call. See {@link fetchSpeechmaticsCostData}.
 *
 * Usage for the current UTC day is excluded from the endpoint's results, so
 * days at or after "today" are never requested — the manifest's
 * `restatementDays` window re-fetches them once they close.
 */

import {
  CostSetupError,
  type CostFetchRange,
  type CostRow,
  type HttpHostServices,
} from "@infrawrench/plugin-base";

/* -------------------------------------------------------------------------- */
/* Rates                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Published Pro-plan list rates in USD per hour of audio, keyed by
 * `{mode}|{operating_point}` — the two fields the usage endpoint breaks
 * consumption down by.
 *
 * Verified against https://www.speechmatics.com/pricing (August 2026; the page
 * renders these from `pricing-table-no-free-allowance.csv`, whose "Pro Plan
 * value" column is quoted here verbatim):
 *
 *   Batch Melia 1        $0.24/hr
 *   Batch Standard       $0.45/hr
 *   Batch Enhanced       $0.75/hr
 *   Real-time Standard   $0.45/hr
 *   Real-time Enhanced   $0.80/hr
 *
 * Melia 1 is batch-only (https://docs.speechmatics.com/speech-to-text/models),
 * which is why there is no real-time entry for it.
 *
 * KNOWN OVER-STATEMENT. Speechmatics applies a volume discount automatically —
 * "Volume discounts are automatically applied on any billable usage above 500
 * hours for each type of Speech-To-Text in a given month", currently 20% off
 * the hours above that threshold, with further discounts negotiated from 24,000
 * hours/year. Flat rate × hours therefore over-states the bill for any account
 * that crosses 500 hours in a month for a given line item, and over-states it
 * more the larger the account is. The tiering is deliberately not modelled:
 * doing so correctly needs the calendar-month running total per line item
 * (which this per-day window does not have) and the account's negotiated terms
 * (which no API exposes), so a half-modelled tier would be confidently wrong
 * rather than predictably high. The same applies in the other direction to the
 * opt-in model-training discount (33% off) and to sign-up credit, neither of
 * which is visible here.
 *
 * `service` is the user-facing dimension value, and matches the line-item names
 * on the pricing page so a row can be read straight across to the rate it came
 * from.
 */
const RATE_CARD: Record<string, { service: string; usdPerHour: number }> = {
  "batch|melia-1": { service: "Batch Melia 1", usdPerHour: 0.24 },
  "batch|standard": { service: "Batch Standard", usdPerHour: 0.45 },
  "batch|enhanced": { service: "Batch Enhanced", usdPerHour: 0.75 },
  "real-time|standard": { service: "Real-time Standard", usdPerHour: 0.45 },
  "real-time|enhanced": { service: "Real-time Enhanced", usdPerHour: 0.8 },
};

/* -------------------------------------------------------------------------- */
/* Pacing                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Minimum gap between consecutive day requests.
 *
 * The endpoint documents a `429 Rate Limited` response but not the ceiling that
 * triggers it, so the only safe design is one that is slow by construction and
 * knowable: requests are issued strictly sequentially with this gap, giving a
 * hard ceiling of ~4 requests/second regardless of how fast the API answers.
 * Concurrency was considered and rejected — with N requests in flight a
 * `Retry-After` from one of them says nothing useful about the others, so the
 * backoff below would be advisory at best, and an undocumented limit is the
 * worst case in which to guess at a safe width.
 */
const MIN_REQUEST_GAP_MS = 250;

/** Attempts per day, including the first. Four attempts ≈ 7s of backoff. */
const MAX_ATTEMPTS = 4;

/** First backoff step; doubles per attempt. */
const BASE_BACKOFF_MS = 1_000;

/** Ceiling for one sleep, so a hostile `Retry-After` can't wedge a collection. */
const MAX_BACKOFF_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                 */
/* -------------------------------------------------------------------------- */

/** `UsageDetails` — the schema names the key `operating_point`, the documented
 * examples show `model` (the field's older name). Both are read. */
interface UsageDetails {
  mode?: string;
  type?: string;
  language?: string;
  operating_point?: string;
  model?: string;
  count?: number;
  duration_hrs?: number;
}

/** `UsageResponse`. */
interface UsageResponse {
  since?: string;
  until?: string;
  summary?: UsageDetails[];
  details?: UsageDetails[];
}

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything this module needs, passed explicitly so it stays a pure function
 * of its inputs and can be driven from a test without a client.
 *
 * `http` and `caCert` are threaded from the host services: `http` is the only
 * request path that picks up bastion egress routing, and the only one that
 * honours a custom CA. This module does not use `jsonRestFetch` because it has
 * to read the `Retry-After` response header on a 429, which that helper (which
 * throws a formatted message and discards the response) cannot surface.
 */
export interface SpeechmaticsCostContext {
  /** Regional endpoint id — `eu1`, `us1` or `au1`. */
  region: string;
  /** The *transcription* API key. The management token cannot read `/usage`. */
  apiKey: string;
  /** Host HTTP service, when the host has one. */
  http?: HttpHostServices | undefined;
  /** Custom CA in PEM form, when the account has one. */
  caCert?: string | undefined;
  /** Test seam for the paced delays. Defaults to a real timer. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Test seam for "now", used to find the last closed UTC day. */
  now?: (() => Date) | undefined;
}

/* -------------------------------------------------------------------------- */
/* Date helpers (pure, UTC)                                                    */
/* -------------------------------------------------------------------------- */

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDay(d);
}

/** Inclusive list of `YYYY-MM-DD` days, empty when `from` is after `to`. */
function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Fold the `mode` spellings that have been observed onto the two the rate card
 * uses. The batch spec's `JobMode` enum only lists `batch`, but `/usage` is
 * account-wide and reports real-time consumption too.
 */
function normalizeMode(mode: string | undefined): string {
  const value = (mode ?? "").trim().toLowerCase().replace(/_/g, "-");
  return value === "realtime" ? "real-time" : value;
}

function normalizeOperatingPoint(entry: UsageDetails): string {
  return (entry.operating_point ?? entry.model ?? "").trim().toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function usageUrl(region: string, day: string): string {
  const params = new URLSearchParams({ since: day, until: day });
  return `https://${region}.asr.api.speechmatics.com/v2/usage?${params.toString()}`;
}

/**
 * One raw GET. Returns non-2xx rather than throwing, because the status and the
 * `Retry-After` header are both load-bearing for the retry policy above.
 */
async function requestUsage(ctx: SpeechmaticsCostContext, day: string): Promise<RawResponse> {
  const url = usageUrl(ctx.region, day);
  const headers = { Authorization: `Bearer ${ctx.apiKey}`, Accept: "application/json" };

  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method: "GET",
      headers,
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return { status: res.status, headers: res.headers ?? {}, body: res.body };
  }

  const res = await fetch(url, { headers });
  const collected: Record<string, string> = {};
  res.headers?.forEach?.((value, key) => {
    collected[key] = value;
  });
  return { status: res.status, headers: collected, body: await res.text() };
}

/** Case-insensitive header lookup — neither transport promises a casing. */
function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * `Retry-After` in milliseconds, honouring both documented forms (delay in
 * seconds, or an HTTP-date). Returns null when absent or unparseable so the
 * caller falls back to exponential backoff.
 */
function retryAfterMs(headers: Record<string, string>, now: Date): number | null {
  const raw = header(headers, "retry-after")?.trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1_000, MAX_BACKOFF_MS);

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now.getTime(), 0), MAX_BACKOFF_MS);
}

/**
 * The single day's usage, with retries. Throws once retries are exhausted, so
 * the host's cost pass owns the reschedule rather than this returning a
 * partial window that would look like a drop in spend.
 */
async function fetchUsageDay(
  ctx: SpeechmaticsCostContext,
  day: string,
  sleep: (ms: number) => Promise<void>,
): Promise<UsageResponse> {
  for (let attempt = 1; ; attempt++) {
    const res = await requestUsage(ctx, day);

    if (res.status >= 200 && res.status < 300) {
      if (!res.body) return {};
      try {
        return JSON.parse(res.body) as UsageResponse;
      } catch {
        throw new Error(
          `Speechmatics plugin: GET /v2/usage for ${day} returned a non-JSON body: ${res.body.slice(0, 200)}`,
        );
      }
    }

    // The one 403 worth explaining. Temporary keys minted with a `client_ref`
    // are scoped to that client's jobs and are explicitly denied the usage
    // endpoint — "temporary keys generated with a `client_ref` can't access
    // the Usage Batch API endpoint and will receive a HTTP 403 - Forbidden"
    // (https://docs.speechmatics.com/introduction/authentication). No amount of
    // retrying fixes it, and the generic "403 Forbidden" body says nothing
    // about which of the account's several credentials is at fault.
    if (res.status === 403) {
      throw new CostSetupError(
        "Speechmatics returned 403 Forbidden for GET /v2/usage. This endpoint rejects " +
          "temporary keys created with a `client_ref` — those are scoped to that client's " +
          "jobs and cannot read account usage. Set this account's API Key credential to a " +
          "long-lived batch API key from the Portal (Manage workspace › API keys) rather " +
          "than a temporary key. Note the Management Token is not an alternative: the " +
          "Management API has no usage endpoint.",
        {
          label: "Speechmatics authentication and temporary keys",
          url: "https://docs.speechmatics.com/introduction/authentication",
        },
      );
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(
        `Speechmatics API error ${res.status} for /usage?since=${day}&until=${day}: ${res.body}`,
      );
    }

    const now = ctx.now?.() ?? new Date();
    const wait =
      retryAfterMs(res.headers, now) ??
      Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    await sleep(wait);
  }
}

/* -------------------------------------------------------------------------- */
/* Collection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Daily cost rows for `range`, one request per day.
 *
 * The host hands this month-aligned chunks (see `monthChunks` in the cost
 * collector), so a single call is at most 31 requests and a first-run backfill
 * is `maxHistoryDays` requests spread over those chunks. They are issued
 * sequentially with {@link MIN_REQUEST_GAP_MS} between them and exponential
 * backoff (or `Retry-After`, when the server sends one) on 429/5xx.
 *
 * Days are only requested once they have closed in UTC: the endpoint excludes
 * the current UTC day from its results, so asking for it spends a request to
 * learn nothing. `restatementDays: 2` on the manifest is what brings today's
 * usage in on a later pass.
 */
export async function fetchSpeechmaticsCostData(
  ctx: SpeechmaticsCostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const now = ctx.now?.() ?? new Date();
  const lastClosedDay = addDays(isoDay(now), -1);
  const toDate = range.toDate < lastClosedDay ? range.toDate : lastClosedDay;
  if (range.fromDate > toDate) return [];

  const sleep = ctx.sleep ?? defaultSleep;

  // Keyed on the full dimension tuple the rows carry — (date, service) — so
  // re-fetching a day during the restatement window reproduces byte-identical
  // keys and the host's ReplacingMergeTree dedupes rather than double-counts.
  // Language and job count are deliberately not part of the key: `service` is
  // the only dimension the manifest declares, so per-language entries for the
  // same model must collapse into one row instead of splitting the day.
  const buckets = new Map<string, CostRow>();

  const days = eachDay(range.fromDate, toDate);
  for (let i = 0; i < days.length; i++) {
    const day = days[i]!;
    if (i > 0) await sleep(MIN_REQUEST_GAP_MS);

    const usage = await fetchUsageDay(ctx, day, sleep);

    // `details` only. `summary` aggregates away `operating_point`, which is
    // the field that decides the rate — a summary row cannot be priced.
    for (const entry of usage.details ?? []) {
      const hours = Number(entry.duration_hrs ?? 0);
      if (!Number.isFinite(hours) || hours <= 0) continue;

      const rate = RATE_CARD[`${normalizeMode(entry.mode)}|${normalizeOperatingPoint(entry)}`];
      // Consumption with no entry on the public rate card — alignment jobs
      // (an Enterprise feature that is priced per contract), or a model
      // released after these constants were written. Priced at a guessed rate
      // it would be a fabricated number; the honest failure is to omit it and
      // under-report, which is one of the ways `estimated: true` warns the
      // reader the total can be wrong.
      if (!rate) continue;

      const key = `${day}|${rate.service}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.amount += hours * rate.usdPerHour;
        existing.usageAmount = (existing.usageAmount ?? 0) + hours;
      } else {
        buckets.set(key, {
          date: day,
          service: rate.service,
          currency: "USD",
          amount: hours * rate.usdPerHour,
          usageAmount: hours,
          usageUnit: "Hours",
        });
      }
    }
  }

  return [...buckets.values()].filter((row) => row.amount !== 0);
}
