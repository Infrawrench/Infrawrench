import type { InstancePricingHostServices } from "./manifest.js";

/**
 * Reads from the instance pricing warehouse (the data behind
 * instances.infrawrench.com) for a plugin's estimates and size pickers. It needs
 * no provider credentials or permissions and prices any number of types in one
 * query, unlike a provider's own price API.
 *
 * Every read answers null when the host has no warehouse or it could not
 * answer, so a plugin can fall back to its provider's API. A result is only ever
 * what the warehouse holds: nothing here estimates a missing price.
 */

/** The `prices` columns a product is priced by; everything else sits in `variant`. */
export const INSTANCE_PRICING_DIMENSIONS = [
  "operating_system",
  "tenancy",
  "database_engine",
  "database_edition",
  "deployment_option",
  "deployment_model",
  "engine_media_type",
  "cache_engine",
  "software_type",
  "component",
  "pre_installed_sw",
  "license_model",
  "capacity_status",
] as const;

/** `UnusedBox` prices idle capacity reservations and `ExtendedSupport*` is a surcharge tier. */
export const INSTANCE_LIST_PRICES_ONLY = `usage_type NOT LIKE '%Unused%' AND usage_type NOT LIKE 'ExtendedSupport%'`;

/** A value as a ClickHouse string literal. */
export function instancePricingLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const VARIANT_KEY = /^variant\.[A-Za-z0-9_]+$/;

/**
 * A selection (a `prices` column, or `variant.<key>`, to a value) as SQL to
 * append to a WHERE clause. An empty value also matches, because some rows leave
 * a dimension unset where it does not apply (EC2 spot has no tenancy). Any other
 * key is ignored.
 */
export function instancePricingSelectionSql(selection: Readonly<Record<string, string>>): string {
  const known = new Set<string>(INSTANCE_PRICING_DIMENSIONS);
  return Object.entries(selection)
    .flatMap(([key, value]) => {
      const values = `(${instancePricingLiteral(value)}, '')`;
      if (known.has(key)) return [` AND ${key} IN ${values}`];
      if (VARIANT_KEY.test(key)) {
        const mapKey = instancePricingLiteral(key.slice("variant.".length));
        return [` AND variant[${mapKey}] IN ${values}`];
      }
      return [];
    })
    .join("");
}

const CACHE_MS = 60 * 60_000;
const CACHE_MAX_ENTRIES = 500;
/** A create form re-estimates as it is edited, so a slow warehouse must not hold it up. */
const TIMEOUT_MS = 8_000;
/** Types per query: the API refuses a statement over 20,000 characters. */
const TYPES_PER_QUERY = 500;
const MAX_ROWS = 5000;

type Row = Record<string, string | number | boolean | null>;

const cache = new Map<string, { at: number; rows: Promise<Row[]> }>();

/** Test hook: clears the module-level cache. */
export function clearInstanceRateCache(): void {
  cache.clear();
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("instance pricing query timed out")), TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function queryRows(pricing: InstancePricingHostServices, sql: string): Promise<Row[]> {
  const hit = cache.get(sql);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const rows = withTimeout(pricing.query(sql, MAX_ROWS)).then((result) =>
    result.rows.map((row): Row =>
      Object.fromEntries(result.columns.map((c, i) => [c.name, row[i] ?? null])),
    ),
  );
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(sql, { at: Date.now(), rows });
  // A failure is not worth remembering: the next attempt may well succeed.
  rows.catch(() => cache.delete(sql));
  return rows;
}

export interface InstanceRateRequest {
  /** The warehouse's `platform`: `ec2`, `rds`, `gcp`, `alibaba`... */
  platform: string;
  /** The warehouse's `region`. */
  region: string;
  instanceTypes: readonly string[];
  /** Which variant to price; see {@link instancePricingSelectionSql}. */
  selection?: Readonly<Record<string, string>>;
}

/**
 * Current on-demand USD hourly rates by instance type. A type the region does
 * not sell is simply absent. Null when the warehouse is unavailable, which is
 * different from it having no price.
 */
export async function fetchInstanceOnDemandRates(
  pricing: InstancePricingHostServices | undefined,
  request: InstanceRateRequest,
): Promise<Record<string, number> | null> {
  if (!pricing || !request.region) return null;
  const types = [...new Set(request.instanceTypes)].filter(Boolean).sort();
  if (types.length === 0) return {};
  const selection = instancePricingSelectionSql(request.selection ?? {});
  const batches: string[][] = [];
  for (let i = 0; i < types.length; i += TYPES_PER_QUERY) {
    batches.push(types.slice(i, i + TYPES_PER_QUERY));
  }
  try {
    const results = await Promise.all(
      batches.map((batch) =>
        queryRows(
          pricing,
          `SELECT instance_type AS instanceType, min(effective_hourly_usd) AS hourly FROM prices WHERE platform = ${instancePricingLiteral(request.platform)} AND instance_type IN (${batch.map(instancePricingLiteral).join(", ")}) AND region = ${instancePricingLiteral(request.region)} AND current AND pricing = 'on_demand' AND ${INSTANCE_LIST_PRICES_ONLY}${selection} GROUP BY instance_type`,
        ),
      ),
    );
    const rates: Record<string, number> = {};
    for (const row of results.flat()) {
      const hourly = Number(row["hourly"]);
      if (Number.isFinite(hourly) && hourly > 0) rates[String(row["instanceType"])] = hourly;
    }
    return rates;
  } catch {
    return null;
  }
}

export interface InstanceCatalogEntry {
  instanceType: string;
  family: string;
  category: string;
  architecture: string;
  vcpus: number;
  memoryMb: number;
}

/**
 * Every current-generation type the provider still lists on a platform, sizes
 * only (they are not specific to a region; prices are). Null when the warehouse
 * is unavailable or holds nothing for the platform.
 */
export async function fetchInstanceCatalog(
  pricing: InstancePricingHostServices | undefined,
  platform: string,
): Promise<InstanceCatalogEntry[] | null> {
  if (!pricing) return null;
  try {
    const rows = await queryRows(
      pricing,
      `SELECT instance_type AS instanceType, family, category, architecture, vcpu, memory_gib AS memoryGib FROM instance_types WHERE platform = ${instancePricingLiteral(platform)} AND retired_at IS NULL AND current_generation AND vcpu IS NOT NULL AND memory_gib IS NOT NULL`,
    );
    if (rows.length === 0) return null;
    return rows.map((row) => ({
      instanceType: String(row["instanceType"]),
      family: String(row["family"] ?? ""),
      category: String(row["category"] ?? ""),
      architecture: String(row["architecture"] ?? ""),
      vcpus: Number(row["vcpu"]),
      memoryMb: Math.round(Number(row["memoryGib"]) * 1024),
    }));
  } catch {
    return null;
  }
}
