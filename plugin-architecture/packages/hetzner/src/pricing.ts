/**
 * Hetzner Cloud rate card — `GET /v1/pricing`.
 *
 * Hetzner Cloud has no billing API. The public spec
 * (https://docs.hetzner.cloud/cloud.spec.json, 151 paths) contains no invoice
 * and no spend endpoint; its own `x-tagGroups` has a "Billing" group whose only
 * tag is "Pricing". Invoices belong to a different product line behind a
 * different credential. So the only number this plugin can produce is
 * inventory × list price, and this module is the list-price half of it.
 *
 * Two things about the payload matter:
 *
 * 1. Every price is a **decimal string** (`"0.0060"`), paired as `{net, gross}`.
 *    `gross` is `net × (1 + vat_rate/100)`; we use `net` throughout, because
 *    anything downstream that applies tax to a gross figure double-counts it.
 * 2. Parsing those strings as IEEE doubles drifts. `3.79 - 3.744` is
 *    `0.04600000000000026` in float, and that lands in a currency column. So
 *    every price here is parsed into a **scaled bigint** — an integer count of
 *    1e-12 currency units — and all arithmetic stays in that domain until a
 *    single conversion at the very end of the pipeline.
 *
 * The rate card is a per-run constant: prices do not change inside one
 * collection pass, and the host calls `fetchCostData` once per month chunk. See
 * {@link createRateCardCache}.
 */

/** Number of decimal places kept in the fixed-point representation. */
const SCALE_EXP = 12;

/** Fixed-point scale: one currency unit is `SCALE` in the scaled domain. */
export const SCALE = 10n ** BigInt(SCALE_EXP);

/**
 * A decimal number held as an integer multiple of 1e-12.
 *
 * It is a plain `bigint`; the alias exists so signatures say which domain a
 * value is in. Mixing a scaled value with an unscaled one is the only real
 * hazard in this module.
 */
export type Scaled = bigint;

/** One TB as Hetzner counts it: binary, matching `included_traffic` in bytes. */
export const BYTES_PER_TB = 2n ** 40n;

const MILLISECONDS_PER_HOUR = 3_600_000n;

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse a decimal string from the API into the scaled domain.
 *
 * Digits past 1e-12 are truncated. Hetzner publishes at most 10 decimal places,
 * so this never fires in practice; it is defined rather than left to chance.
 */
export function parseDecimal(value: string | number, field: string): Scaled {
  // Numbers reach here from inventory quantities (a snapshot's size in GB),
  // never from the rate card. `String()` on a small or huge one yields
  // exponent notation, which the pattern below rejects, so normalize first.
  const raw =
    typeof value === "number"
      ? Number.isFinite(value)
        ? String(value).includes("e") || String(value).includes("E")
          ? value.toFixed(SCALE_EXP)
          : String(value)
        : "not-a-number"
      : String(value ?? "").trim();
  if (!DECIMAL_PATTERN.test(raw)) {
    throw new Error(
      `Hetzner pricing: ${field} is not a decimal number (got ${JSON.stringify(value)})`,
    );
  }
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[+-]/, "");
  const dot = unsigned.indexOf(".");
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? "" : unsigned.slice(dot + 1);
  const padded = (fraction + "0".repeat(SCALE_EXP)).slice(0, SCALE_EXP);
  const magnitude = BigInt((whole || "0") + padded);
  return negative ? -magnitude : magnitude;
}

/**
 * Convert a scaled value to the `number` a {@link CostRow} carries.
 *
 * Goes via the exact decimal string rather than `Number(v) / 1e12` so the
 * result is the double nearest the true decimal — `0.046`, not
 * `0.04600000000000026`. This is the single float conversion in the pipeline
 * and it happens once per emitted row.
 */
export function toNumber(value: Scaled): number {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = (magnitude / SCALE).toString();
  const fraction = (magnitude % SCALE).toString().padStart(SCALE_EXP, "0").replace(/0+$/, "");
  return Number(`${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`);
}

/**
 * `value × numerator / denominator`, staying in the scaled domain, rounded
 * half away from zero. Used for every proration (hours in a day, days in a
 * month, bytes in a TB) so no intermediate ever becomes a float.
 */
export function mulDiv(value: Scaled, numerator: bigint, denominator: bigint): Scaled {
  if (denominator === 0n) throw new Error("Hetzner pricing: division by zero");
  const product = value * numerator;
  const negative = product < 0n !== denominator < 0n;
  const absProduct = product < 0n ? -product : product;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absProduct / absDenominator;
  const remainder = absProduct % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** `value × (percent / 100)`, where `percent` is itself scaled. */
export function percentOf(value: Scaled, percent: Scaled): Scaled {
  return mulDiv(value, percent, 100n * SCALE);
}

/** An hourly rate with the monthly cap Hetzner never bills past. */
export interface CappedRate {
  hourly: Scaled;
  monthly: Scaled;
}

/** A server type's rate in one location, including its traffic allowance. */
export interface ServerTypeRate extends CappedRate {
  /** Bytes of outgoing traffic included per billing period. */
  includedTraffic: bigint;
  /** Price of one TB (2^40 bytes) of outgoing traffic beyond the allowance. */
  perTbTraffic: Scaled;
}

/** The parsed rate card: everything `fetchHetznerCostData` needs to price. */
export interface HetznerRateCard {
  /** ISO 4217, from the project itself — commonly EUR, not always. */
  currency: string;
  /** VAT percentage, scaled. Recorded for documentation; never applied. */
  vatRatePercent: Scaled;
  /** `server type name → location name → rate`. */
  serverTypes: Map<string, Map<string, ServerTypeRate>>;
  /** `load balancer type name → location name → rate`. */
  loadBalancerTypes: Map<string, Map<string, ServerTypeRate>>;
  /** `ip type (ipv4/ipv6) → location name → rate`. */
  primaryIps: Map<string, Map<string, CappedRate>>;
  /** `ip type (ipv4/ipv6) → location name → monthly price`. */
  floatingIps: Map<string, Map<string, Scaled>>;
  /** Fallback monthly price from the deprecated singular `floating_ip` block. */
  floatingIpFallbackMonthly: Scaled | undefined;
  volumePerGbMonth: Scaled;
  imagePerGbMonth: Scaled;
  /** Backups cost this percentage *of the server's own price*, not a flat fee. */
  serverBackupPercent: Scaled;
}

/** Shape of the `{net, gross}` pair the API pairs every price into. */
interface RawPrice {
  net?: string;
  gross?: string;
}

interface RawLocationPrice {
  location?: string;
  price_hourly?: RawPrice;
  price_monthly?: RawPrice;
  included_traffic?: number | null;
  price_per_tb_traffic?: RawPrice;
}

interface RawTypeEntry {
  name?: string;
  type?: string;
  prices?: RawLocationPrice[];
}

interface RawPricingResponse {
  pricing?: {
    currency?: string;
    vat_rate?: string;
    server_types?: RawTypeEntry[];
    load_balancer_types?: RawTypeEntry[];
    primary_ips?: RawTypeEntry[];
    floating_ips?: RawTypeEntry[];
    /** Deprecated since 2024-08-29 in favour of `floating_ips`. */
    floating_ip?: { price_monthly?: RawPrice };
    volume?: { price_per_gb_month?: RawPrice };
    image?: { price_per_gb_month?: RawPrice };
    server_backup?: { percentage?: string };
  };
}

/**
 * Read `net` from a `{net, gross}` pair.
 *
 * `gross` is `net × (1 + vat_rate/100)`. Every amount this plugin reports is
 * ex-VAT, so that the host (or the reader) can apply whatever tax treatment
 * actually applies to the account rather than inheriting Hetzner's German rate.
 */
function net(price: RawPrice | undefined, field: string): Scaled {
  if (!price || price.net == null) {
    throw new Error(`Hetzner pricing: missing net price for ${field}`);
  }
  return parseDecimal(price.net, field);
}

function optionalNet(price: RawPrice | undefined, field: string): Scaled {
  return price?.net == null ? 0n : parseDecimal(price.net, field);
}

function cappedRates(
  entries: RawTypeEntry[] | undefined,
  keyOf: (entry: RawTypeEntry) => string | undefined,
  label: string,
): Map<string, Map<string, ServerTypeRate>> {
  const out = new Map<string, Map<string, ServerTypeRate>>();
  for (const entry of entries ?? []) {
    const key = keyOf(entry);
    if (!key) continue;
    const byLocation = new Map<string, ServerTypeRate>();
    for (const price of entry.prices ?? []) {
      if (!price.location) continue;
      byLocation.set(price.location, {
        hourly: net(price.price_hourly, `${label} ${key} hourly`),
        monthly: net(price.price_monthly, `${label} ${key} monthly`),
        includedTraffic: BigInt(Math.max(0, Math.trunc(price.included_traffic ?? 0))),
        perTbTraffic: optionalNet(price.price_per_tb_traffic, `${label} ${key} traffic`),
      });
    }
    out.set(key, byLocation);
  }
  return out;
}

/** Parse a `/pricing` body into the typed, decimal-safe rate card. */
export function parseRateCard(body: RawPricingResponse): HetznerRateCard {
  const pricing = body?.pricing;
  if (!pricing) throw new Error("Hetzner pricing: /pricing returned no pricing object");

  const primaryIps = new Map<string, Map<string, CappedRate>>();
  for (const entry of pricing.primary_ips ?? []) {
    if (!entry.type) continue;
    const byLocation = new Map<string, CappedRate>();
    for (const price of entry.prices ?? []) {
      if (!price.location) continue;
      byLocation.set(price.location, {
        hourly: optionalNet(price.price_hourly, `primary ip ${entry.type} hourly`),
        monthly: optionalNet(price.price_monthly, `primary ip ${entry.type} monthly`),
      });
    }
    primaryIps.set(entry.type, byLocation);
  }

  // `floating_ips` (plural, per-location) replaced the singular `floating_ip`
  // block on 2024-08-29. The singular one is still sent and still deprecated;
  // it is only consulted when the plural list has no entry for a location.
  const floatingIps = new Map<string, Map<string, Scaled>>();
  for (const entry of pricing.floating_ips ?? []) {
    if (!entry.type) continue;
    const byLocation = new Map<string, Scaled>();
    for (const price of entry.prices ?? []) {
      if (!price.location) continue;
      byLocation.set(price.location, optionalNet(price.price_monthly, `floating ip ${entry.type}`));
    }
    floatingIps.set(entry.type, byLocation);
  }

  return {
    currency: pricing.currency || "EUR",
    vatRatePercent: pricing.vat_rate ? parseDecimal(pricing.vat_rate, "vat_rate") : 0n,
    serverTypes: cappedRates(pricing.server_types, (e) => e.name, "server type"),
    loadBalancerTypes: cappedRates(
      pricing.load_balancer_types,
      (e) => e.name,
      "load balancer type",
    ),
    primaryIps,
    floatingIps,
    floatingIpFallbackMonthly: pricing.floating_ip?.price_monthly?.net
      ? parseDecimal(pricing.floating_ip.price_monthly.net, "floating_ip (deprecated)")
      : undefined,
    volumePerGbMonth: optionalNet(pricing.volume?.price_per_gb_month, "volume per GB-month"),
    imagePerGbMonth: optionalNet(pricing.image?.price_per_gb_month, "image per GB-month"),
    serverBackupPercent: pricing.server_backup?.percentage
      ? parseDecimal(pricing.server_backup.percentage, "server_backup.percentage")
      : 0n,
  };
}

/** The one capability {@link fetchRateCard} needs from the caller. */
export interface PricingFetcher {
  fetch<T>(path: string): Promise<T>;
}

/** Fetch and parse the rate card. Uses the project token already held. */
export async function fetchRateCard(fetcher: PricingFetcher): Promise<HetznerRateCard> {
  return parseRateCard(await fetcher.fetch<RawPricingResponse>("/pricing"));
}

/**
 * Memoizes the rate card for the lifetime of one collection pass.
 *
 * The host builds a client per pass and calls `fetchCostData` once per month
 * chunk; sharing one cache across those calls keeps `/pricing` to a single
 * request against a 3600-request hourly budget. Failures are not cached — a
 * rejected promise is dropped so the next chunk retries.
 */
export interface RateCardCache {
  load(fetcher: PricingFetcher): Promise<HetznerRateCard>;
}

export function createRateCardCache(): RateCardCache {
  let pending: Promise<HetznerRateCard> | undefined;
  return {
    load(fetcher) {
      if (!pending) {
        pending = fetchRateCard(fetcher).catch((error: unknown) => {
          pending = undefined;
          throw error;
        });
      }
      return pending;
    },
  };
}

/**
 * Cost of a resource from `startMs` to `endMs`, hourly but never above the
 * monthly cap.
 *
 * This is Hetzner's stated rule — "the minimum amount, whether that is the
 * monthly price cap or the hourly price multiplied by the number of hours you
 * used the server" — applied to a window that always starts at the billing
 * period boundary, because the cap is a *per-period* cap.
 */
export function cappedCost(rate: CappedRate, startMs: number, endMs: number): Scaled {
  const elapsed = Math.max(0, endMs - startMs);
  const uncapped = mulDiv(rate.hourly, BigInt(Math.round(elapsed)), MILLISECONDS_PER_HOUR);
  return uncapped < rate.monthly || rate.monthly === 0n ? uncapped : rate.monthly;
}

/**
 * The share of one day's cost that a monthly-priced resource contributes.
 *
 * Volumes, snapshots and floating IPs are quoted per month with no hourly rate
 * in the rate card, so a day is priced as `monthly × covered / month`. Over a
 * whole month these sum back to exactly the monthly price.
 */
export function proratedDailyCost(monthly: Scaled, coveredMs: number, daysInMonth: number): Scaled {
  if (coveredMs <= 0) return 0n;
  const monthMs = BigInt(daysInMonth) * 86_400_000n;
  return mulDiv(monthly, BigInt(Math.round(coveredMs)), monthMs);
}
