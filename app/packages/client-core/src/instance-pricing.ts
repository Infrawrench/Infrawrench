import {
  INSTANCE_LIST_PRICES_ONLY,
  INSTANCE_PRICING_DIMENSIONS,
  instancePricingLiteral as literal,
  instancePricingSelectionSql as selectionSql,
  type InstancePricingCell,
  type InstancePricingResult,
} from "@infrawrench/plugin-base";
import { INSTANCE_PRICING_KEY } from "./instance-pricing-key";

/**
 * The client half of the resource page's instance pricing panel: the one call
 * to `POST /api/v1/instance-pricing/query`, the SQL the panel runs and the pure
 * shaping of its results. Shared so web and desktop only differ in how a request
 * reaches the API (same-origin fetch, or IPC to the main process).
 */

export type { InstancePricingCell, InstancePricingResult };

/** How a host runs one statement. Rejects with a message fit to show. */
export type InstancePricingQuery = (sql: string, maxRows: number) => Promise<InstancePricingResult>;

/** The panel's own row cap; no query below comes near it for one instance type. */
export const INSTANCE_PRICING_MAX_ROWS = 5000;

/**
 * Run one statement against `baseUrl` (empty for same-origin), authenticated
 * with the key in `./instance-pricing-key`, which is valid on this route alone.
 */
export async function queryInstancePricing(
  baseUrl: string,
  sql: string,
  maxRows: number,
  fetchImpl: typeof fetch = fetch,
): Promise<InstancePricingResult> {
  const res = await fetchImpl(`${baseUrl}/api/v1/instance-pricing/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${INSTANCE_PRICING_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql, maxRows }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
  }
  return (await res.json()) as InstancePricingResult;
}

/** Hours in the month every instance price on the site and in the app is quoted over. */
export const INSTANCE_HOURS_PER_MONTH = 730;

const SITE = "https://instances.infrawrench.com";

/** Page paths of the platforms whose URL is not `/aws/<platform>`. */
const SITE_PLATFORM_PATHS: Readonly<Record<string, string>> = {
  azure: "/azure/vms",
  gcp: "/gcp/compute",
  alibaba: "/alibaba/ecs",
  runpod: "/runpod/pods",
};

/** The instance's page on instances.infrawrench.com. */
export function instancePricingPageUrl(
  platform: string,
  instanceType: string,
  region?: string,
): string {
  const base = SITE_PLATFORM_PATHS[platform] ?? `/aws/${encodeURIComponent(platform)}`;
  const query = region ? `?region=${encodeURIComponent(region)}` : "";
  return `${SITE}${base}/${encodeURIComponent(instanceType)}${query}`;
}

export { INSTANCE_PRICING_DIMENSIONS };

const typeSql = (platform: string, instanceType: string) =>
  `platform = ${literal(platform)} AND instance_type = ${literal(instanceType)}`;

export function instanceSpecsSql(platform: string, instanceType: string): string {
  return `SELECT family, architecture, vcpu, memory_gib, gpus, gpu_memory_gib, gpu_model, processor, clock_speed_ghz, network_performance, storage, category, current_generation, regions_offered, first_listed, retired_at, attributes FROM instance_types WHERE ${typeSql(platform, instanceType)} LIMIT 1`;
}

export function instanceFreshnessSql(platform: string): string {
  return `SELECT argMax(price_list_to, synced_at) AS asOf FROM sync_state WHERE source = ${literal(platform)}`;
}

export function offeredRegionsSql(platform: string, instanceType: string): string {
  return `SELECT DISTINCT region FROM prices WHERE ${typeSql(platform, instanceType)} AND current AND pricing = 'on_demand' ORDER BY region`;
}

export function regionNamesSql(platform: string): string {
  return `SELECT region, location FROM regions WHERE source = ${literal(platform)} LIMIT 2000`;
}

/** Every price on offer now for the type in one region, in every variant. */
export function regionOffersSql(platform: string, instanceType: string, region: string): string {
  return `SELECT pricing, lease, offering_class, purchase_option, ${INSTANCE_PRICING_DIMENSIONS.join(", ")}, variant, hourly_usd, upfront_usd, effective_hourly_usd FROM prices WHERE ${typeSql(platform, instanceType)} AND region = ${literal(region)} AND current AND ${INSTANCE_LIST_PRICES_ONLY}`;
}

/** The selected variant's on-demand periods in every region: prices by region and availability. */
export function onDemandByRegionSql(
  platform: string,
  instanceType: string,
  selection: Readonly<Record<string, string>>,
): string {
  return `SELECT region, toUnixTimestamp(valid_from) AS validFrom, toUnixTimestamp(valid_to) AS validTo, effective_hourly_usd AS price FROM prices WHERE ${typeSql(platform, instanceType)} AND pricing = 'on_demand' AND ${INSTANCE_LIST_PRICES_ONLY}${selectionSql(selection)}`;
}

export function spotByRegionSql(
  platform: string,
  instanceType: string,
  selection: Readonly<Record<string, string>>,
): string {
  return `SELECT region, min(effective_hourly_usd) AS price FROM prices WHERE ${typeSql(platform, instanceType)} AND pricing = 'spot' AND current${selectionSql(selection)} GROUP BY region`;
}

/** On-demand and committed periods in one region; spot is {@link spotHistorySql}, being hourly. */
export function priceHistorySql(
  platform: string,
  instanceType: string,
  region: string,
  selection: Readonly<Record<string, string>>,
): string {
  return `SELECT pricing, lease, offering_class, purchase_option, toUnixTimestamp(valid_from) AS validFrom, toUnixTimestamp(valid_to) AS validTo, effective_hourly_usd AS price FROM prices WHERE ${typeSql(platform, instanceType)} AND region = ${literal(region)} AND pricing != 'spot' AND ${INSTANCE_LIST_PRICES_ONLY}${selectionSql(selection)} ORDER BY valid_from`;
}

/** Spot history at one point a day, which is all a chart this size can show. */
export function spotHistorySql(
  platform: string,
  instanceType: string,
  region: string,
  selection: Readonly<Record<string, string>>,
): string {
  return `SELECT toUnixTimestamp(toStartOfDay(valid_from)) AS at, min(effective_hourly_usd) AS price FROM prices WHERE ${typeSql(platform, instanceType)} AND region = ${literal(region)} AND pricing = 'spot'${selectionSql(selection)} GROUP BY at ORDER BY at`;
}

export function familySizesSql(
  platform: string,
  family: string,
  region: string,
  selection: Readonly<Record<string, string>>,
): string {
  return `SELECT instance_type AS instanceType, any(vcpu) AS vcpu, any(memory_gib) AS memoryGib, any(gpus) AS gpus, min(effective_hourly_usd) AS price FROM prices WHERE platform = ${literal(platform)} AND family = ${literal(family)} AND region = ${literal(region)} AND current AND pricing = 'on_demand' AND ${INSTANCE_LIST_PRICES_ONLY}${selectionSql(selection)} GROUP BY instance_type ORDER BY price, instance_type`;
}

export function attributeChangesSql(
  platform: string,
  instanceType: string,
  region: string,
): string {
  return `SELECT attribute, toUnixTimestamp(at) AS at, value FROM attribute_changes WHERE ${typeSql(platform, instanceType)} AND region IN (${literal(region)}, '') ORDER BY at`;
}

/** A result as one object per row, keyed by column name. */
export function instancePricingRows(
  result: InstancePricingResult,
): Record<string, InstancePricingCell>[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((col, i) => [col.name, row[i] ?? null])),
  );
}

export interface InstancePriceOffer {
  pricing: string;
  lease: string;
  offeringClass: string;
  purchaseOption: string;
  /** Dimension (a `prices` column, or `variant.<key>`) to its non-empty value. */
  dimensions: Record<string, string>;
  hourly: number;
  upfront: number;
  effective: number;
}

/** The result of {@link regionOffersSql}. */
export function parseInstanceOffers(result: InstancePricingResult): InstancePriceOffer[] {
  return instancePricingRows(result).map((row) => {
    const dimensions: Record<string, string> = {};
    for (const key of INSTANCE_PRICING_DIMENSIONS) {
      const value = row[key];
      if (typeof value === "string" && value) dimensions[key] = value;
    }
    // Maps arrive as JSON text.
    if (typeof row["variant"] === "string" && row["variant"]) {
      try {
        const variant = JSON.parse(row["variant"]) as Record<string, unknown>;
        for (const [key, value] of Object.entries(variant)) {
          if (typeof value === "string" && value) dimensions[`variant.${key}`] = value;
        }
      } catch {
        // A variant that does not parse only costs its picker.
      }
    }
    return {
      pricing: String(row["pricing"] ?? ""),
      lease: String(row["lease"] ?? ""),
      offeringClass: String(row["offering_class"] ?? ""),
      purchaseOption: String(row["purchase_option"] ?? ""),
      dimensions,
      hourly: Number(row["hourly_usd"] ?? 0),
      upfront: Number(row["upfront_usd"] ?? 0),
      effective: Number(row["effective_hourly_usd"] ?? 0),
    };
  });
}

export interface InstancePricingDimension {
  key: string;
  values: string[];
  value: string;
}

export interface ResolvedInstanceSelection {
  /** A value for every dimension the region's prices use. */
  selection: Record<string, string>;
  /** The dimensions with more than one value to pick between. */
  choices: InstancePricingDimension[];
}

/**
 * The selection nearest to `wanted` that the region really sells. Dimensions
 * narrow in turn so each picker only offers combinations that exist: `wanted`
 * first and in its own order, so what a resource runs (or the last thing picked,
 * put first) is never lost to a dimension nobody asked about, which then opens
 * on its cheapest value.
 */
export function resolveInstanceSelection(
  offers: readonly InstancePriceOffer[],
  wanted: Readonly<Record<string, string>>,
): ResolvedInstanceSelection {
  const onDemand = offers.filter((o) => o.pricing === "on_demand");
  let pool = onDemand.length > 0 ? onDemand : [...offers];
  const variantKeys = [...new Set(pool.flatMap((o) => Object.keys(o.dimensions)))]
    .filter((key) => key.startsWith("variant."))
    .sort();
  const selection: Record<string, string> = {};
  const choices: InstancePricingDimension[] = [];
  const canonical: string[] = [...INSTANCE_PRICING_DIMENSIONS, ...variantKeys];
  const order = [...new Set([...Object.keys(wanted), ...canonical])];
  for (const key of order) {
    const values = [...new Set(pool.flatMap((o) => o.dimensions[key] ?? []))].sort();
    if (values.length === 0) continue;
    const want = wanted[key];
    let value = want !== undefined && values.includes(want) ? want : undefined;
    if (value === undefined) {
      const cheapest = pool.reduce((best, o) =>
        o.dimensions[key] !== undefined &&
        (best.dimensions[key] === undefined || o.effective < best.effective)
          ? o
          : best,
      );
      value = cheapest.dimensions[key]!;
    }
    selection[key] = value;
    if (values.length > 1) choices.push({ key, values, value });
    pool = pool.filter((o) => o.dimensions[key] === value);
  }
  choices.sort((a, b) => canonical.indexOf(a.key) - canonical.indexOf(b.key));
  return { selection, choices };
}

/** Whether an offer is the selected variant; a dimension the row leaves unset always matches. */
export function offerMatchesSelection(
  offer: InstancePriceOffer,
  selection: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(selection).every(([key, value]) => {
    const own = offer.dimensions[key];
    return own === undefined || own === value;
  });
}

/** One committed option across its leases, such as "standard, No Upfront". */
export function instanceTermKey(offer: { offeringClass: string; purchaseOption: string }): string {
  return `${offer.offeringClass}|${offer.purchaseOption}`;
}

/** A lease such as `1yr` or `3mo` in months, for ordering; unknown forms sort last. */
export function instanceLeaseMonths(lease: string): number {
  const match = /^(\d+)\s*(yr|mo)/.exec(lease);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * (match[2] === "yr" ? 12 : 1);
}

/** The committed option a panel opens on: standard no-upfront when sold, else the first. */
export function defaultInstanceTerm(keys: readonly string[]): string {
  return keys.includes("standard|No Upfront") ? "standard|No Upfront" : (keys[0] ?? "");
}

export interface InstancePricePeriod {
  validFrom: number;
  /** Null while it is still on offer. */
  validTo: number | null;
  price: number;
}

/**
 * Periods as step points, `[at, price]`, oldest first, `null` meaning not on
 * offer from then on. Where periods overlap the lowest price wins, since the
 * same variant can be listed under more than one usage type.
 */
export function instancePriceSteps(
  periods: readonly InstancePricePeriod[],
): [number, number | null][] {
  const moments = [
    ...new Set(
      periods.flatMap((p) => (p.validTo === null ? [p.validFrom] : [p.validFrom, p.validTo])),
    ),
  ].sort((a, b) => a - b);
  const points: [number, number | null][] = [];
  for (const at of moments) {
    let lowest: number | null = null;
    for (const p of periods) {
      if (p.validFrom > at || (p.validTo !== null && p.validTo <= at)) continue;
      if (lowest === null || p.price < lowest) lowest = p.price;
    }
    if (points[points.length - 1]?.[1] !== lowest) points.push([at, lowest]);
  }
  return points;
}

/** How many regions offered the type over time, from each region's on-demand periods. */
export function instanceRegionCountSteps(
  rows: readonly (InstancePricePeriod & { region: string })[],
): [number, number][] {
  const byRegion = new Map<string, InstancePricePeriod[]>();
  for (const row of rows) {
    const periods = byRegion.get(row.region);
    if (periods) periods.push(row);
    else byRegion.set(row.region, [row]);
  }
  const deltas = new Map<number, number>();
  for (const periods of byRegion.values()) {
    // A region counts once however many prices it has had: only the moments
    // it starts or stops being priced at all change the count.
    let priced = false;
    for (const [at, price] of instancePriceSteps(periods)) {
      const now = price !== null;
      if (now !== priced) deltas.set(at, (deltas.get(at) ?? 0) + (now ? 1 : -1));
      priced = now;
    }
  }
  let count = 0;
  const points: [number, number][] = [];
  for (const at of [...deltas.keys()].sort((a, b) => a - b)) {
    count += deltas.get(at)!;
    points.push([at, count]);
  }
  return points;
}
