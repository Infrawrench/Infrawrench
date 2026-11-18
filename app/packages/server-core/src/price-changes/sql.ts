/**
 * The warehouse SQL behind the price-change watch. A change is two adjacent
 * periods of one product in `prices`: the old period's `valid_to` is the new
 * one's `valid_from` (the loader closes one and opens the next at the same
 * instant), the same self-join the bulk-pricing sync's social posts use.
 *
 * Only on-demand rows: they are what a running instance pays at list price.
 * Spot moves every few hours and committed terms are bought, not paid by the
 * hour, so neither is news about a running bill. `$0` on-demand rows mean the
 * provider has no capacity to sell, not a free instance, so they are left out.
 */
import {
  INSTANCE_LIST_PRICES_ONLY,
  INSTANCE_PRICING_DIMENSIONS,
  instancePricingLiteral as literal,
} from "@infrawrench/plugin-base";

/** Every column that tells two products of one instance type and region apart. */
const PRODUCT = `cityHash64(platform, instance_type, region, pricing, lease, offering_class, purchase_option,
  operating_system, tenancy, license_model, pre_installed_sw, capacity_status, database_engine,
  database_edition, deployment_option, deployment_model, engine_media_type, cache_engine,
  software_type, component, usage_type, variant)`;

/** The headline price only: Linux, shared, nothing bundled, standard priority. */
const HEADLINE = `operating_system IN ('', 'Linux') AND tenancy IN ('', 'Shared')
  AND pre_installed_sw IN ('', 'NA') AND capacity_status IN ('', 'Used')
  AND license_model IN ('', 'No License required', 'No license required')
  AND variant['priority'] IN ('', 'Regular') AND variant['provisioningModel'] IN ('', 'Standard')`;

/** A UTC instant as a ClickHouse DateTime literal. */
export function dateTimeLiteral(at: Date): string {
  return `toDateTime(${literal(at.toISOString().slice(0, 19).replace("T", " "))}, 'UTC')`;
}

/** Instance types per org query, which keeps a statement far under the API's 20,000 characters. */
export const TYPES_PER_QUERY = 150;

/**
 * Price moves since `since` for the given instance types and regions of one
 * platform, every variant, with each variant's dimension columns so the
 * caller can match a resource's selection. Columns: instance_type, region,
 * the dimension columns, variant, old_usd, new_usd, effective_at (unix seconds).
 */
export function orgPriceMovesSql(
  platform: string,
  instanceTypes: readonly string[],
  regions: readonly string[],
  since: Date,
): string {
  const where = [
    `platform = ${literal(platform)}`,
    `pricing = 'on_demand'`,
    `instance_type IN (${instanceTypes.map(literal).join(", ")})`,
    `region IN (${regions.map(literal).join(", ")})`,
    `hourly_usd > 0`,
    INSTANCE_LIST_PRICES_ONLY,
  ].join(" AND ");
  const dims = INSTANCE_PRICING_DIMENSIONS.map((d) => `n.${d} AS ${d}`).join(", ");
  const after = dateTimeLiteral(since);
  return `SELECT n.instance_type AS instance_type, n.region AS region, ${dims}, n.variant AS variant,
  o.hourly_usd AS old_usd, n.hourly_usd AS new_usd, toUnixTimestamp(n.valid_from) AS effective_at
FROM (
  SELECT ${PRODUCT} AS product, instance_type, region, ${INSTANCE_PRICING_DIMENSIONS.join(", ")}, variant, hourly_usd, valid_from
  FROM prices WHERE ${where} AND valid_from > ${after}
) AS n
INNER JOIN (
  SELECT ${PRODUCT} AS product, hourly_usd, valid_to
  FROM prices WHERE ${where} AND valid_to > ${after}
) AS o ON n.product = o.product AND n.valid_from = o.valid_to
WHERE n.hourly_usd != o.hourly_usd`;
}

/**
 * Every headline price move on one platform since `since`, newest first.
 * Columns: instance_type, region, variant_text, old_usd, new_usd,
 * effective_at (unix seconds), vcpu, memory_gib.
 */
export function catalogPriceMovesSql(platform: string, since: Date, limit: number): string {
  const where = [
    `platform = ${literal(platform)}`,
    `pricing = 'on_demand'`,
    `hourly_usd > 0`,
    INSTANCE_LIST_PRICES_ONLY,
    HEADLINE,
  ].join(" AND ");
  const after = dateTimeLiteral(since);
  return `SELECT n.instance_type AS instance_type, n.region AS region,
  arrayStringConcat(arrayFilter(x -> x != '', [n.database_engine, n.database_edition, n.deployment_option, n.cache_engine, n.component]), ', ') AS variant_text,
  o.hourly_usd AS old_usd, n.hourly_usd AS new_usd, toUnixTimestamp(n.valid_from) AS effective_at,
  n.vcpu AS vcpu, n.memory_gib AS memory_gib
FROM (
  SELECT ${PRODUCT} AS product, instance_type, region, database_engine, database_edition, deployment_option, cache_engine, component, vcpu, memory_gib, hourly_usd, valid_from
  FROM prices WHERE ${where} AND valid_from > ${after}
) AS n
INNER JOIN (
  SELECT ${PRODUCT} AS product, hourly_usd, valid_to
  FROM prices WHERE ${where} AND valid_to > ${after}
) AS o ON n.product = o.product AND n.valid_from = o.valid_to
WHERE n.hourly_usd != o.hourly_usd
ORDER BY effective_at DESC, abs(new_usd / old_usd - 1) DESC
LIMIT ${Math.max(1, Math.floor(limit))}`;
}

/** The platforms the warehouse prices, for the provider picker. */
export const WAREHOUSE_PLATFORMS_SQL = `SELECT DISTINCT platform FROM instance_types ORDER BY platform`;
