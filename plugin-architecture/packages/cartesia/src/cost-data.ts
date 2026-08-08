/**
 * Spend collection from Cartesia's credit-usage API.
 *
 * `GET /usage/credits?start_ts=&end_ts=&interval=day&group_by=capability`
 * (https://docs.cartesia.ai/api-reference/usage/credits) returns clean daily
 * buckets of *credits consumed*, grouped by the capability that burned them
 * (TTS, STT, voice changer, voice cloning…). Two properties of that endpoint
 * shape everything below:
 *
 * 1. **It needs the admin key.** Credit usage is one of the routes Cartesia
 *    gates behind a separate `sk_car_admin_…` key; a standard `sk_car_` key is
 *    rejected outright, and the two are not interchangeable
 *    (https://docs.cartesia.ai/use-the-api/api-conventions). With no admin key
 *    on the account there is nothing to collect, so this throws
 *    {@link CostSetupError} rather than reporting a permanent zero.
 * 2. **It returns credits, not money.** Cartesia publishes no USD-per-credit
 *    rate and no overage rate — the only published prices are plan bundles, so
 *    the conversion here is plan price ÷ included credits. See
 *    {@link USD_PER_CREDIT}. That makes every amount an estimate, which is why
 *    the manifest declares `estimated: true`.
 *
 * `start_ts` is rounded down to the start of its UTC day and `end_ts` up to the
 * start of the next one, and the two may not span more than a year, so longer
 * backfills are chunked (see {@link MAX_CHUNK_DAYS}).
 */

import type { CostFetchRange, CostRow, HttpHostServices } from "@infrawrench/plugin-base";
import { CostSetupError, jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * USD per credit.
 *
 * Cartesia bills in credits (1 credit ≈ 1 TTS character; 1–3 credits per second
 * of STT audio; 15 per second through the voice changer) and publishes no
 * per-credit or overage price. The only public prices are the plan bundles at
 * https://cartesia.ai/pricing (verified 2026-08-08):
 *
 *   Free        $0    ·    20 K credits
 *   Pro         $5    ·   100 K credits   →  $0.0000500/credit
 *   Startup    $49    ·  1.25 M credits   →  $0.0000392/credit
 *   Scale     $299    ·     8 M credits   →  $0.0000374/credit
 *   Enterprise custom
 *
 * The API exposes no plan field, so a single rate has to stand in for all of
 * them. This uses the Scale rate — $299 / 8,000,000 — because it is the lowest
 * published rate, and under-reporting a small account's spend is the less
 * misleading failure than inflating a large one's. An account on Pro is being
 * modelled ~34 % low; an account on a negotiated Enterprise contract is not
 * modelled at all. Amounts are therefore an estimate of consumption value, not
 * an invoice figure — see the `estimated: true` declaration in plugin.ts.
 */
export const USD_PER_CREDIT = 299 / 8_000_000;

/**
 * Inclusive days per request. Cartesia rejects a `start_ts`/`end_ts` pair
 * spanning more than a year; a 365-day inclusive window spans exactly one
 * non-leap year, which is never more than a calendar year from the same start.
 */
const MAX_CHUNK_DAYS = 365;

/** Everything cost collection needs from the client, and nothing more. */
export interface CartesiaCostContext {
  /** Admin key (`sk_car_admin_…`). Blank → {@link CostSetupError}. */
  adminApiKey: string;
  /** Pinned API date sent as `Cartesia-Version` on every call. */
  apiVersion: string;
  /** API origin, e.g. `https://api.cartesia.ai`. */
  baseUrl: string;
  /** PEM trust anchor, when the account carries one. */
  caCert?: string;
  /** Host HTTP service — required for `caCert` and bastion routing to apply. */
  http?: HttpHostServices;
}

/** One `interval=day` bucket. */
interface CreditBucket {
  start_ts?: string;
  end_ts?: string;
  credits?: number;
}

/** One `group_by` group, each carrying its own daily buckets. */
interface CreditGroup extends CreditBucket {
  id?: string;
  label?: string;
  buckets?: CreditBucket[];
}

interface CreditsResponse {
  group_by?: string;
  data?: CreditGroup[];
}

/** `2026-07-01` + 3 → `2026-07-04`. Pure UTC date arithmetic. */
function addDays(date: string, days: number): string {
  const ms = new Date(`${date}T00:00:00Z`).valueOf() + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Split an inclusive date range into windows of at most {@link MAX_CHUNK_DAYS}
 * days, because the endpoint refuses anything longer in one call.
 */
export function chunkRange(range: CostFetchRange): CostFetchRange[] {
  const chunks: CostFetchRange[] = [];
  let fromDate = range.fromDate;
  // Bounded loop: the host's backfill is capped at maxHistoryDays, so this is
  // a handful of iterations in the worst case.
  while (fromDate <= range.toDate) {
    const last = addDays(fromDate, MAX_CHUNK_DAYS - 1);
    const toDate = last < range.toDate ? last : range.toDate;
    chunks.push({ fromDate, toDate });
    fromDate = addDays(toDate, 1);
  }
  return chunks;
}

/** The capability that burned the credits, as the `service` dimension. */
function groupService(group: CreditGroup): string {
  const label = (group.label ?? "").trim();
  if (label) return label;
  const id = (group.id ?? "").trim();
  return id || "Usage";
}

/**
 * Grouped responses nest daily buckets under each group; an ungrouped one puts
 * the buckets at the top level. Read both so a response without `group_by`
 * (e.g. an account whose credits predate capability tagging) still lands.
 */
function bucketsOf(group: CreditGroup): CreditBucket[] {
  if (Array.isArray(group.buckets)) return group.buckets;
  return group.start_ts ? [group] : [];
}

/**
 * The one setup failure this plugin can hit: no admin key on the account, so
 * `/usage/credits` can never be called at all. Built here rather than at each
 * call site so the message and the deep link stay identical wherever the guard
 * fires — the host stores this against the account and shows it in place of
 * the missing spend.
 */
export function cartesiaCostSetupError(): CostSetupError {
  return new CostSetupError(
    "Cartesia cost collection needs an admin API key. /usage/credits rejects the standard " +
      "sk_car_ key — credit usage is admin-only — so add an admin key (sk_car_admin_…) to " +
      "this account. Only organization admins can create one.",
    {
      label: "Create an admin key",
      // Must be https: — the host drops a help link with any other scheme.
      url: "https://play.cartesia.ai/keys/admin",
    },
  );
}

export async function fetchCartesiaCostData(
  ctx: CartesiaCostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  if (!ctx.adminApiKey) throw cartesiaCostSetupError();

  // Key on the full dimension tuple this plugin reports (date + service), so
  // re-fetching a day during the restatement window reproduces byte-identical
  // keys and the host's dedupe replaces rather than duplicates. Credits are
  // summed and converted once at the end to avoid drifting on repeated
  // floating-point multiplies.
  const credits = new Map<string, { date: string; service: string; credits: number }>();

  for (const chunk of chunkRange(range)) {
    const query = new URLSearchParams({
      // Rounded down to the start of the UTC day by the API.
      start_ts: `${chunk.fromDate}T00:00:00Z`,
      // Rounded *up* to the start of the next UTC day, so end-of-day here
      // yields buckets through toDate inclusive.
      end_ts: `${chunk.toDate}T23:59:59Z`,
      interval: "day",
      group_by: "capability",
    });

    const body = await jsonRestFetch<CreditsResponse>({
      vendor: "Cartesia",
      url: `${ctx.baseUrl}/usage/credits?${query.toString()}`,
      errorPath: "/usage/credits",
      headers: {
        Authorization: `Bearer ${ctx.adminApiKey}`,
        "Cartesia-Version": ctx.apiVersion,
        Accept: "application/json",
      },
      ...(ctx.http ? { http: ctx.http } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });

    for (const group of body.data ?? []) {
      const service = groupService(group);
      for (const bucket of bucketsOf(group)) {
        const date = (bucket.start_ts ?? "").slice(0, 10);
        if (!date || date < range.fromDate || date > range.toDate) continue;
        const value = Number(bucket.credits ?? 0);
        if (!Number.isFinite(value) || value === 0) continue;
        const key = `${date}|${service}`;
        const existing = credits.get(key);
        if (existing) existing.credits += value;
        else credits.set(key, { date, service, credits: value });
      }
    }
  }

  return [...credits.values()].map((entry) => ({
    date: entry.date,
    service: entry.service,
    currency: "USD",
    amount: entry.credits * USD_PER_CREDIT,
    usageAmount: entry.credits,
    usageUnit: "Credits",
  }));
}
