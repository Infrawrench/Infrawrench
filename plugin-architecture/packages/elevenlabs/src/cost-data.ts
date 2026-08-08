/**
 * Actual-spend collection for ElevenLabs.
 *
 * ElevenLabs exposes the same usage warehouse through two endpoints, and this
 * module builds against the newer one with a fallback to the older:
 *
 * 1. `POST /v1/workspace/analytics/query/usage-by-product-over-time` — the
 *    successor, and what we prefer.
 * 2. `GET  /v1/usage/character-stats` — **deprecated**, kept only as a
 *    fallback. Its own description now reads "(Deprecated) This endpoint is
 *    deprecated. Use /v1/workspace/analytics/query/usage-by-product-over-time
 *    instead, which exposes the bucket size as `interval_seconds` (an integer
 *    in seconds) rather than [`aggregation_interval`]".
 *
 * Both shapes were verified against the live OpenAPI document served at
 * https://api.elevenlabs.io/openapi.json (August 2026), which is authoritative
 * here: at time of writing the successor has **no rendered page** in the public
 * API reference — https://elevenlabs.io/docs/api-reference/usage/get documents
 * the deprecated endpoint and names its replacement, but the replacement's own
 * reference page 404s. The spec entry is `operationId: usage_by_product_over_time`,
 * SDK group `workspace.usage`, method `get_usage_by_product_over_time`.
 *
 * What the successor actually looks like (this differs from the deprecated
 * endpoint in every dimension, which is why the fallback is a separate path
 * rather than a tweaked query string):
 *
 * - It is a **POST with a JSON body**, not a GET with query parameters.
 * - Body: `start_time` / `end_time` (Unix **milliseconds**, both required, each
 *   must be >= 2020-01-01), `interval_seconds` (bucket size in seconds;
 *   whole-day multiples such as 86400 align to local midnight), optional
 *   `group_by`, optional `filters`, optional `time_zone` (IANA, default UTC).
 * - `group_by` is an **array** — unlike the deprecated endpoint's single-valued
 *   `breakdown_type`, the successor can break down by several dimensions at
 *   once. That is what lets us key rows on a real (service, region) tuple.
 *   Enum: product_type, model, voice_id, user_id, fiat_currency,
 *   fiat_charge_type, region, reporting_workspace_id, request_source,
 *   resource_id, subresource_id, request_queue_type, voice_multiplier,
 *   hashed_xi_api_key, billing_group_id, surface, actor.
 * - There is **no `metric` parameter**. The response is a generic tabular
 *   result — `columns`, `column_types`, `column_units`, `rows` — so the money
 *   column is discovered from `column_units` rather than requested by name.
 *
 * Rows are aggregated per (day, service, region, currency) so that re-fetching
 * a day inside the restatement window reproduces byte-identical dimension keys
 * and the host's dedupe replaces rather than doubles them.
 *
 * Auth is the plugin's existing `apiKey`, sent as `xi-api-key` — no extra
 * credential field. Workspace-analytics access can be denied to a narrowly
 * scoped personal key, so every failure mode here degrades rather than
 * assuming; see `fetchElevenLabsCostData` for the ladder.
 */

import type { CostFetchRange, CostRow, HttpHostServices } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";

const API_BASE = "https://api.elevenlabs.io";

const USAGE_BY_PRODUCT_PATH = "/v1/workspace/analytics/query/usage-by-product-over-time";
const CHARACTER_STATS_PATH = "/v1/usage/character-stats";
const SUBSCRIPTION_PATH = "/v1/user/subscription";

const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;

const API_KEYS_HELP = {
  label: "ElevenLabs API keys",
  url: "https://elevenlabs.io/app/settings/api-keys",
};

/**
 * Explicit context object so this module stays a pure function of its inputs —
 * no `ElevenLabsClient` instance, no `HostServices` graph, nothing to stub in
 * tests beyond these three fields.
 */
export interface ElevenLabsCostContext {
  /** Sent as the `xi-api-key` header. */
  apiKey: string;
  /** PEM trust anchor, or "" for the OS trust store. Only honored via `http`. */
  caCert: string;
  /**
   * Host HTTP service. Preferred whenever present: it is the only path that
   * picks up bastion routing for accounts that have one attached, and the only
   * path that can honor `caCert`. Absent in the renderer and in tests, which
   * fall through to the global `fetch`.
   */
  http: HttpHostServices | undefined;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** `WorkspaceAnalyticsQueryResponseModel` — the successor's tabular result. */
interface AnalyticsQueryResponse {
  columns?: string[] | null;
  /** ClickHouse-flavoured: String | Float | DateTime | Int | Bool | JSON | Map | Array. */
  column_types?: Array<string | null> | null;
  /** `ColumnUnit`: ms | s | min | duration | credits | usd | eur | inr | pln | ratio | rating. */
  column_units?: Array<string | null> | null;
  rows?: Array<Array<string | number | boolean | null>> | null;
}

/** The deprecated endpoint's response: a time axis plus one series per breakdown key. */
interface CharacterStatsResponse {
  time?: number[] | null;
  usage?: Record<string, Array<number | null>> | null;
}

/** `SubscriptionResponseModel` — only the field this module reads. */
interface SubscriptionResponse {
  /** `Currency` enum: usd | eur | inr | pln. */
  currency?: string | null;
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

/**
 * The `ColumnUnit` values that denote money rather than a quantity. This is
 * exactly the `Currency` enum from the same spec document (usd, eur, inr, pln),
 * which is how we know a currency-valued unit is a billing currency and not,
 * say, a duration.
 */
const CURRENCY_UNITS = new Set(["usd", "eur", "inr", "pln"]);

/**
 * Last-resort billing currency.
 *
 * ASSUMPTION, stated loudly because the deprecated endpoint gives us nothing
 * better: `metric=fiat_units_spent` on `/v1/usage/character-stats` returns bare
 * numbers with **no currency field anywhere in the response**. We therefore
 * establish the currency out-of-band, in this order:
 *
 *   1. the successor's per-row `fiat_currency` group-by column;
 *   2. the successor's `column_units` entry for the money column;
 *   3. `GET /v1/user/subscription` → `currency`, whose enum is the same four
 *      values (usd, eur, inr, pln);
 *   4. this constant.
 *
 * USD is the defensible default only because it is the currency ElevenLabs
 * publishes all of its pricing in and the only one a workspace gets without
 * explicitly being billed in a regional currency. It is a *fallback*, not a
 * belief — steps 1-3 mean a EUR/INR/PLN workspace is reported correctly, and
 * this line is reached only when the subscription lookup also fails.
 *
 * Note also that `fiat_units_spent` is read as **major units** (dollars, not
 * cents). Nothing in the spec states the scale; major units is the reading
 * consistent with the successor tagging its money column `usd` (a currency,
 * whose natural unit is major) rather than something like `cents`.
 */
const FALLBACK_CURRENCY = "USD";

/** Normalize a spec-cased currency ("usd") to the ISO 4217 code CostRow wants. */
function normalizeCurrency(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!/^[A-Za-z]{3}$/.test(trimmed)) return "";
  return trimmed.toUpperCase();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
}

/**
 * Raw request returning the status instead of throwing on it.
 *
 * `jsonRestFetch` would collapse every failure into a message string, and this
 * module has to branch on the exact status: a 404 from the successor means
 * "fall back to the deprecated endpoint", a 403 means "this key lacks workspace
 * analytics", and those lead to completely different behavior. Mirrors
 * `jsonRestFetch`'s dual path so bastion routing and `caCert` still work.
 */
async function request(
  ctx: ElevenLabsCostContext,
  path: string,
  init?: { method?: string; body?: string },
): Promise<RawResponse> {
  const url = `${API_BASE}${path}`;
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {
    "xi-api-key": ctx.apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (ctx.http) {
    const result = await ctx.http.request({
      url,
      method,
      headers,
      ...(init?.body !== undefined ? { body: init.body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return { status: result.status, body: result.body };
  }

  const res = await fetch(url, {
    method,
    headers,
    ...(init?.body !== undefined ? { body: init.body } : {}),
  });
  return { status: res.status, body: await res.text() };
}

function parseJson<T>(res: RawResponse, path: string): T {
  if (!res.body) return {} as T;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(
      `ElevenLabs API returned a malformed JSON body for ${path}: ${res.body.slice(0, 200)}`,
    );
  }
}

function apiError(res: RawResponse, path: string): Error {
  return new Error(`ElevenLabs API error ${res.status} for ${path}: ${res.body.slice(0, 500)}`);
}

/** 401/403 — the key exists but is not allowed to read this. */
function isForbidden(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Statuses that mean "this endpoint is not here" rather than "this request was
 * bad". 404/405 cover a path that has not shipped to the caller's region yet;
 * 501 covers a deployment that knows the route but does not implement it.
 */
function isMissingEndpoint(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function dayStartMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`);
}

/**
 * Coerce whatever the time column holds into a `YYYY-MM-DD` UTC day.
 *
 * Three shapes are in play: the deprecated endpoint's Unix integers, and the
 * successor's ClickHouse `DateTime`, which serializes either as ISO 8601 or as
 * `YYYY-MM-DD HH:MM:SS` (space-separated, no zone). Any string already leading
 * with a calendar date is sliced directly — parsing it would risk a local-time
 * reinterpretation that shifts the bucket by a day.
 */
function toIsoDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds vs milliseconds: 1e11 seconds is year 5138, 1e11 ms is 1973, so
    // anything below the threshold is seconds.
    const ms = Math.abs(value) < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return "";
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * One accumulator per (day, service, region, currency). The key is the full
 * dimension tuple exactly as it will be written to the row, so a re-fetch of
 * the same day produces the same keys and the host's dedupe can replace the
 * previous version instead of adding to it.
 */
interface Bucket {
  date: string;
  service: string;
  region: string;
  currency: string;
  amount: number;
  credits: number;
}

function bucketKey(date: string, service: string, region: string, currency: string): string {
  return `${date}|${service}|${region}|${currency}`;
}

function accumulate(
  buckets: Map<string, Bucket>,
  date: string,
  service: string,
  region: string,
  currency: string,
  amount: number,
  credits: number,
): void {
  const key = bucketKey(date, service, region, currency);
  const existing = buckets.get(key);
  if (existing) {
    existing.amount += amount;
    existing.credits += credits;
    return;
  }
  buckets.set(key, { date, service, region, currency, amount, credits });
}

function toRows(buckets: Map<string, Bucket>): CostRow[] {
  const rows: CostRow[] = [];
  for (const bucket of buckets.values()) {
    // A zero bucket is a day with no spend on that tuple — nothing to store,
    // and emitting it would make empty windows look like collected data.
    if (bucket.amount === 0) continue;
    rows.push({
      date: bucket.date,
      ...(bucket.service ? { service: bucket.service } : {}),
      ...(bucket.region ? { region: bucket.region } : {}),
      currency: bucket.currency,
      amount: bucket.amount,
      // ElevenLabs' native meter. Kept alongside the money so a reader can see
      // the consumption behind a charge without a second query.
      ...(bucket.credits > 0 ? { usageAmount: bucket.credits, usageUnit: "credits" } : {}),
    });
  }
  // Stable order keeps assertions and diffs readable; the host does not care.
  rows.sort((a, b) => bucketKeyOf(a).localeCompare(bucketKeyOf(b)));
  return rows;
}

function bucketKeyOf(row: CostRow): string {
  return bucketKey(row.date, row.service ?? "", row.region ?? "", row.currency);
}

/**
 * Workspace billing currency from `GET /v1/user/subscription`. Step 3 of the
 * currency ladder — only consulted when the usage response did not carry one.
 * Never throws: a key without `user_read` still has usable cost data, so a
 * failure here degrades to {@link FALLBACK_CURRENCY} rather than failing the
 * whole collection.
 */
async function workspaceCurrency(ctx: ElevenLabsCostContext): Promise<string> {
  try {
    const res = await request(ctx, SUBSCRIPTION_PATH);
    if (res.status < 200 || res.status >= 300) return FALLBACK_CURRENCY;
    const body = parseJson<SubscriptionResponse>(res, SUBSCRIPTION_PATH);
    return normalizeCurrency(body.currency) || FALLBACK_CURRENCY;
  } catch {
    return FALLBACK_CURRENCY;
  }
}

// ---------------------------------------------------------------------------
// Primary path — POST /v1/workspace/analytics/query/usage-by-product-over-time
// ---------------------------------------------------------------------------

/**
 * Column names we will accept as the money column when `column_units` did not
 * settle it. `fiat_units_spent` is the deprecated endpoint's name for the same
 * measure and the most likely name for the successor's column; the rest are
 * defensive.
 */
const MONEY_COLUMN_NAMES = ["fiat_units_spent", "fiat_units", "cost", "spend", "amount"];

const TIME_COLUMN_NAMES = ["time", "timestamp", "bucket", "bucket_start", "start_time", "date"];

interface ColumnPlan {
  timeIdx: number;
  moneyIdx: number;
  creditsIdx: number;
  serviceIdx: number;
  regionIdx: number;
  currencyIdx: number;
  /** Currency implied by the money column's unit, or "" if the unit was not one. */
  unitCurrency: string;
}

/**
 * Locate the columns we need in a tabular response.
 *
 * The successor has no `metric` parameter and the spec does not enumerate the
 * column names it returns, so the money column is found by **unit** first —
 * `column_units[i]` being one of the four currency values is a positive
 * statement from the API that column `i` holds money in that currency — and
 * only then by name. Returns `null` when there is no usable money column,
 * which the caller treats as schema drift and falls back on.
 */
function planColumns(body: AnalyticsQueryResponse): ColumnPlan | null {
  const columns = body.columns ?? [];
  const types = body.column_types ?? [];
  const units = body.column_units ?? [];

  const nameIdx = (candidates: string[]): number =>
    columns.findIndex((name) => candidates.includes(name.toLowerCase()));

  let timeIdx = types.findIndex((type) => type === "DateTime");
  if (timeIdx < 0) timeIdx = nameIdx(TIME_COLUMN_NAMES);

  // Money by unit, preferring a column whose name also reads like spend so a
  // response carrying several currency-tagged columns picks the total rather
  // than whichever happened to come first.
  const currencyCols: number[] = [];
  units.forEach((unit, idx) => {
    if (typeof unit === "string" && CURRENCY_UNITS.has(unit.toLowerCase())) currencyCols.push(idx);
  });
  let moneyIdx = currencyCols.find((idx) =>
    MONEY_COLUMN_NAMES.includes((columns[idx] ?? "").toLowerCase()),
  );
  if (moneyIdx === undefined) moneyIdx = currencyCols[0];
  if (moneyIdx === undefined) {
    const byName = nameIdx(MONEY_COLUMN_NAMES);
    if (byName >= 0) moneyIdx = byName;
  }
  if (moneyIdx === undefined || timeIdx < 0) return null;

  const unitRaw = units[moneyIdx];
  const unitCurrency =
    typeof unitRaw === "string" && CURRENCY_UNITS.has(unitRaw.toLowerCase())
      ? unitRaw.toUpperCase()
      : "";

  const creditsIdx = units.findIndex((unit) => typeof unit === "string" && unit === "credits");

  return {
    timeIdx,
    moneyIdx,
    creditsIdx,
    serviceIdx: nameIdx(["product_type"]),
    regionIdx: nameIdx(["region"]),
    currencyIdx: nameIdx(["fiat_currency"]),
    unitCurrency,
  };
}

/**
 * Query the successor. Returns `null` to mean "use the fallback" — either the
 * route is not there, or it answered with a shape we cannot read. Throws only
 * for failures the fallback would hit too.
 */
async function fetchViaAnalytics(
  ctx: ElevenLabsCostContext,
  range: CostFetchRange,
): Promise<CostRow[] | null> {
  // `end_time` is inclusive of the final day: the last bucket must start on
  // `toDate`, so we aim at the last millisecond of it rather than midnight.
  const payload = {
    start_time: dayStartMs(range.fromDate),
    end_time: dayStartMs(range.toDate) + DAY_MS - 1,
    // Whole-day multiple, which the spec says aligns buckets to local midnight
    // — pinned to UTC below so "local" is the same UTC day the host asked for.
    interval_seconds: DAY_SECONDS,
    // Multi-valued, which the deprecated endpoint could not do. `fiat_currency`
    // is requested purely so each row states its own currency.
    group_by: ["product_type", "region", "fiat_currency"],
    time_zone: "UTC",
  };

  const res = await request(ctx, USAGE_BY_PRODUCT_PATH, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (isMissingEndpoint(res.status)) return null;
  // A narrowly scoped personal key can be refused workspace analytics while
  // still reading its own usage, so a refusal here is also a fallback, not a
  // failure. If the deprecated endpoint refuses too, that path raises.
  if (isForbidden(res.status)) return null;
  if (res.status < 200 || res.status >= 300) throw apiError(res, USAGE_BY_PRODUCT_PATH);

  const body = parseJson<AnalyticsQueryResponse>(res, USAGE_BY_PRODUCT_PATH);
  const plan = planColumns(body);
  if (!plan) return null;

  const rows = body.rows ?? [];
  // An empty window is a real answer — no spend in the range — not drift.
  if (rows.length === 0) return [];

  let defaultCurrency = plan.unitCurrency;
  if (!defaultCurrency) defaultCurrency = await workspaceCurrency(ctx);

  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const date = toIsoDate(row[plan.timeIdx]);
    if (!date) continue;
    // Bucket alignment can spill a partial bucket past the requested window.
    if (date < range.fromDate || date > range.toDate) continue;

    const amount = toNumber(row[plan.moneyIdx]);
    const credits = plan.creditsIdx >= 0 ? toNumber(row[plan.creditsIdx]) : 0;
    if (amount === 0 && credits === 0) continue;

    const service = plan.serviceIdx >= 0 ? toLabel(row[plan.serviceIdx]) : "";
    const region = plan.regionIdx >= 0 ? toLabel(row[plan.regionIdx]) : "";
    const currency =
      (plan.currencyIdx >= 0 ? normalizeCurrency(row[plan.currencyIdx]) : "") || defaultCurrency;

    accumulate(buckets, date, service, region, currency, amount, credits);
  }

  return toRows(buckets);
}

// ---------------------------------------------------------------------------
// Fallback path — GET /v1/usage/character-stats (deprecated)
// ---------------------------------------------------------------------------

/**
 * Query the deprecated endpoint.
 *
 * `breakdown_type` here is **single-valued** — one dimension per request — so
 * unlike the successor this path cannot produce a (service, region) tuple. It
 * deliberately asks for `product_type` **only** and leaves `region` unset,
 * rather than issuing a second `breakdown_type=region` call: the two responses
 * are independent full-total decompositions of the same money, so combining
 * them would report every dollar twice, and there is no key by which to cross
 * them back into pairs. A missing region is a gap; a doubled total is a lie.
 *
 * `include_workspace_metrics=true` widens the numbers from the calling user to
 * the whole workspace. Whether that requires an admin key is not documented, so
 * it is probed and dropped on refusal rather than assumed either way.
 */
async function fetchViaCharacterStats(
  ctx: ElevenLabsCostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const base = {
    // Documented as milliseconds: window start at 00:00:00 and end at 23:59:59.
    start_unix: String(dayStartMs(range.fromDate)),
    end_unix: String(dayStartMs(range.toDate) + DAY_MS - 1),
    aggregation_interval: "day",
    // Real money, as opposed to `credits` / `tts_characters` / `minutes_used`.
    metric: "fiat_units_spent",
    breakdown_type: "product_type",
  };

  const query = (workspaceWide: boolean): string =>
    new URLSearchParams(
      workspaceWide ? { ...base, include_workspace_metrics: "true" } : base,
    ).toString();

  let path = `${CHARACTER_STATS_PATH}?${query(true)}`;
  let res = await request(ctx, path);
  if (isForbidden(res.status)) {
    // Probe failed — this key is not allowed to see workspace-wide totals.
    // Retry scoped to the caller: partial numbers beat none.
    path = `${CHARACTER_STATS_PATH}?${query(false)}`;
    res = await request(ctx, path);
  }

  if (isForbidden(res.status)) {
    throw new CostSetupError(
      "This ElevenLabs API key cannot read usage. Grant it the User / usage read scope, " +
        "or replace it with a workspace key, then re-run cost collection.",
      API_KEYS_HELP,
    );
  }
  if (res.status < 200 || res.status >= 300) throw apiError(res, CHARACTER_STATS_PATH);

  const body = parseJson<CharacterStatsResponse>(res, CHARACTER_STATS_PATH);
  const time = body.time ?? [];
  const usage = body.usage ?? {};
  if (time.length === 0) return [];

  // No currency anywhere in this response — step 3 of the ladder.
  const currency = await workspaceCurrency(ctx);

  const buckets = new Map<string, Bucket>();
  for (const [service, series] of Object.entries(usage)) {
    if (!Array.isArray(series)) continue;
    for (let i = 0; i < time.length; i += 1) {
      const date = toIsoDate(time[i]);
      if (!date) continue;
      if (date < range.fromDate || date > range.toDate) continue;
      const amount = toNumber(series[i]);
      if (amount === 0) continue;
      // Region intentionally "" — see the note above on single-valued breakdowns.
      accumulate(buckets, date, service, "", currency, amount, 0);
    }
  }

  return toRows(buckets);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Daily ElevenLabs spend for the requested window.
 *
 * Tries the successor first and falls back to the deprecated endpoint when the
 * successor is absent, refuses this key, or answers in a shape we cannot read.
 * Building it this way round means the deprecation cycle that eventually
 * removes `/v1/usage/character-stats` is a no-op for us.
 */
export async function fetchElevenLabsCostData(
  ctx: ElevenLabsCostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const viaAnalytics = await fetchViaAnalytics(ctx, range);
  if (viaAnalytics !== null) return viaAnalytics;
  return fetchViaCharacterStats(ctx, range);
}
