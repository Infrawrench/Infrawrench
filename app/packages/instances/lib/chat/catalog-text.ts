import type { QueryResult } from "@infrawrench/server-core/aws-pricing-warehouse/query";

/**
 * The catalog's queries and how their results read in the system prompt
 * (`catalog.ts` runs and caches them). Kept apart so tests can load it
 * without the Workers runtime.
 */

/** Columns listed per platform, in the order they are shown. */
const COLUMNS = [
  "pricing",
  "lease",
  "offering_class",
  "purchase_option",
  "operating_system",
  "tenancy",
  "license_model",
  "pre_installed_sw",
  "capacity_status",
  "database_engine",
  "database_edition",
  "deployment_option",
  "deployment_model",
  "engine_media_type",
  "cache_engine",
  "software_type",
  "component",
  "usage_type",
  "architecture",
] as const;

/** Values listed per column, most common first; the rest are summarized as a count. */
const MAX_VALUES = 25;

/**
 * One pass over current prices with a `topK` per column (an ARRAY JOIN
 * across every column times out on the warehouse): per platform, each
 * column's most common non-empty values and how many it has.
 */
export const VALUES_SQL = `
SELECT platform${COLUMNS.map(
  (c) =>
    `,\n  topKIf(${MAX_VALUES})(${c}, ${c} != '') AS ${c}__values, uniqIf(${c}, ${c} != '') AS ${c}__count`,
).join("")}
FROM prices
WHERE current
GROUP BY platform`;

/** The same for the variant map, one row per platform and key. */
export const VARIANT_SQL = `
SELECT platform, concat('variant[''', k, ''']') AS col, topK(${MAX_VALUES})(v) AS values, uniq(v) AS distinct_values
FROM prices
ARRAY JOIN mapKeys(variant) AS k, mapValues(variant) AS v
WHERE current AND v != ''
GROUP BY platform, col`;

// Codes only: AWS lists a few locations by name, with no code.
export const REGIONS_SQL = `
SELECT multiIf(source IN ('alibaba', 'azure', 'gcp', 'runpod', 'oracle', 'ibm'), source, source IN ('hetzner', 'hetznerauction'), 'hetzner', source IN ('ovh', 'ovheco'), 'ovh', 'aws') AS cloud,
       region, any(location) AS name
FROM regions
WHERE location_type IN ('AWS Region', 'Alibaba Cloud Region', 'Azure Region', 'Google Cloud Region', 'Hetzner Location', 'OVHcloud Pricing Zone', 'OVHcloud Data Center', 'IBM Cloud Region')
  AND region != location
GROUP BY cloud, region
ORDER BY cloud, region`;

const PLATFORM_ORDER = [
  "ec2",
  "rds",
  "elasticache",
  "memorydb",
  "opensearch",
  "redshift",
  "docdb",
  "neptune",
  "dax",
  "sagemaker",
  "emr",
  "gamelift",
  "azure",
  "gcp",
  "alibaba",
  "oracle",
  "ibm",
  "hetzner",
  "hetznerauction",
  "ovh",
  "ovheco",
  "runpod",
];
const CLOUD_NAMES: Record<string, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "Google Cloud",
  alibaba: "Alibaba Cloud",
  ibm: "IBM Cloud",
  hetzner: "Hetzner",
  ovh: "OVHcloud",
};

const rank = (order: readonly string[], value: string) => {
  const i = order.indexOf(value);
  return i < 0 ? order.length : i;
};

const literal = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

type ValueRow = [platform: string, col: string, values: string, distinct: number];

/** `VALUES_SQL`'s wide rows in `VARIANT_SQL`'s shape: platform, column, values (JSON text), count. */
function longRows(values: QueryResult): ValueRow[] {
  const index = new Map(values.columns.map((c, i) => [c.name, i]));
  const out: ValueRow[] = [];
  for (const row of values.rows) {
    for (const col of COLUMNS) {
      const list = row[index.get(`${col}__values`) ?? -1];
      const count = Number(row[index.get(`${col}__count`) ?? -1] ?? 0);
      if (typeof list === "string" && count > 0) out.push([String(row[0]), col, list, count]);
    }
  }
  return out;
}

/** The catalog as prompt text, from the results of the three queries. */
export function formatCatalog(
  values: QueryResult,
  variants: QueryResult,
  regions: QueryResult,
): string {
  const byPlatform = new Map<string, { col: string; line: string }[]>();
  for (const [platform, col, raw, distinct] of [
    ...longRows(values),
    ...(variants.rows as ValueRow[]),
  ]) {
    // Arrays arrive as JSON text (see queryWarehouse).
    const list = JSON.parse(raw) as string[];
    if (!list.length) continue;
    const more = distinct > list.length ? `, and ${distinct - list.length} more` : "";
    const entry = { col, line: `${col}: ${list.map(literal).join(", ")}${more}` };
    byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), entry]);
  }
  const columnOrder: string[] = [...COLUMNS];
  const platforms = [...byPlatform.keys()].sort(
    (a, b) => rank(PLATFORM_ORDER, a) - rank(PLATFORM_ORDER, b) || a.localeCompare(b),
  );
  const valueLines = platforms.map((platform) => {
    const entries = byPlatform
      .get(platform)!
      .sort(
        (a, b) => rank(columnOrder, a.col) - rank(columnOrder, b.col) || a.col.localeCompare(b.col),
      );
    return `- ${platform}: ${entries.map((e) => e.line).join("; ")}`;
  });

  const byCloud = new Map<string, string[]>();
  for (const [cloud, region, location] of regions.rows as [string, string, string][]) {
    byCloud.set(cloud, [...(byCloud.get(cloud) ?? []), `${region} (${location})`]);
  }
  const regionLines = [...byCloud.entries()]
    .sort(([a], [b]) => rank(Object.keys(CLOUD_NAMES), a) - rank(Object.keys(CLOUD_NAMES), b))
    .map(([cloud, list]) => `- ${CLOUD_NAMES[cloud] ?? cloud}: ${list.join(", ")}`);

  return [
    "Values in the data now. Every non-empty value each column has among current prices, per platform, most common first, written as SQL literals. Use these instead of querying for them; a column a platform does not list is always '' there.",
    ...valueLines,
    "",
    "Region codes and their names (regions proper; AWS Local Zones, Wavelength Zones and Outposts are only in the regions table). RunPod's only region is 'global'.",
    ...regionLines,
  ].join("\n");
}
