/**
 * AWS extended support: the support calendars and surcharge prices for EKS,
 * RDS / Aurora, ElastiCache (Redis OSS) and OpenSearch Service, plus the
 * Cost Explorer read that finds what was actually billed.
 *
 * Everything here was checked against AWS's own pages on 2026-10-04 and must
 * be refreshed when AWS publishes a new version row or a new rate:
 *
 * - EKS: https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html
 *   and https://aws.amazon.com/eks/pricing/. Extended support is $0.60 per
 *   cluster-hour, billed as the usual $0.10 `perCluster` line plus a $0.50
 *   `extendedSupport` line; the surcharge (what an upgrade removes) is the
 *   $0.50, flat in every commercial region. A cluster whose upgrade policy is
 *   `STANDARD` is upgraded at the end of standard support instead of billed.
 *   The 1.25-1.28 rows are no longer on AWS's page (their extended support has
 *   ended); their dates come from the page's published history.
 * - RDS / Aurora: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support-charges.html,
 *   the RDS MySQL / PostgreSQL / Aurora release calendars, and the RDS price
 *   list. $0.100 per vCPU-hour in years 1-2, $0.200 in year 3, in us-east-1;
 *   other regions are higher (eu-west-1 $0.112, sa-east-1 $0.210), which is
 *   why the computed figure carries a price note and the billed figure wins.
 *   Instances whose `EngineLifecycleSupport` is
 *   `open-source-rds-extended-support-disabled` are upgraded instead.
 * - ElastiCache: https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/extended-support.html.
 *   Priced as a premium on the node's own on-demand rate (+80% in years 1-2,
 *   +160% in year 3), so no rate is declared and only the billed figure can
 *   state an amount. MemoryDB has no extended-support programme.
 * - OpenSearch: https://docs.aws.amazon.com/opensearch-service/latest/developerguide/what-is.html#end-of-support
 *   and https://aws.amazon.com/opensearch-service/pricing/. $0.0065 per
 *   normalized instance hour (instance hours x the size factor) in us-east-1;
 *   under the August 2026 timeline extension, versions past their original
 *   end pay a surcharge equal to the instance price from 2026-11-07.
 */
import type {
  ExtendedSupportCharge,
  ExtendedSupportDeclaration,
  ExtendedSupportRelease,
} from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { fetchSigned } from "./signed-request.js";

const EKS_VERSIONS_URL =
  "https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html";
const EKS_UPGRADE_URL = "https://docs.aws.amazon.com/eks/latest/userguide/update-cluster.html";
const EKS_PRICING_URL = "https://aws.amazon.com/eks/pricing/";
const RDS_PRICING_URL =
  "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support-charges.html";
const RDS_MYSQL_UPGRADE_URL =
  "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.MySQL.html";
const RDS_POSTGRES_UPGRADE_URL =
  "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.PostgreSQL.html";
const AURORA_MYSQL_UPGRADE_URL =
  "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Updates.MajorVersionUpgrade.html";
const AURORA_POSTGRES_UPGRADE_URL =
  "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_UpgradeDBInstance.PostgreSQL.MajorVersion.html";
const ELASTICACHE_URL =
  "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/extended-support.html";
const ELASTICACHE_UPGRADE_URL =
  "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/VersionManagement.html";
const OPENSEARCH_URL =
  "https://docs.aws.amazon.com/opensearch-service/latest/developerguide/what-is.html#end-of-support";
const OPENSEARCH_UPGRADE_URL =
  "https://docs.aws.amazon.com/opensearch-service/latest/developerguide/version-migration.html";

const US_EAST_NOTE = "US East (N. Virginia) list price; other regions differ.";

// ─── EKS ────────────────────────────────────────────────────────────────────

/** [version, last day of standard support, last day of extended support]. */
const EKS_CALENDAR: Array<[string, string, string]> = [
  ["1.25", "2024-04-30", "2025-04-30"],
  ["1.26", "2024-06-10", "2025-06-10"],
  ["1.27", "2024-07-23", "2025-07-23"],
  ["1.28", "2024-11-25", "2025-11-25"],
  ["1.29", "2025-03-22", "2026-03-22"],
  ["1.30", "2025-07-22", "2026-07-22"],
  ["1.31", "2025-11-25", "2026-11-25"],
  ["1.32", "2026-03-22", "2027-03-22"],
  ["1.33", "2026-07-28", "2027-07-28"],
  ["1.34", "2026-12-01", "2027-12-01"],
  ["1.35", "2027-03-26", "2028-03-26"],
];

export const EKS_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "version",
  regionFieldKey: "region",
  chargedWhen: [{ fieldKey: "supportType", notIn: ["STANDARD"] }],
  notChargedNote:
    "This cluster's upgrade policy is STANDARD, so EKS upgrades its control plane at the end of standard support instead of billing extended support.",
  releases: EKS_CALENDAR.map(([version, standardEnd, extendedEnd]): ExtendedSupportRelease => ({
    id: `k8s-${version}`,
    product: "Amazon EKS",
    versions: [version],
    standardSupportEnds: standardEnd,
    extendedSupportEnds: extendedEnd,
    targetVersion: "1.35",
    surcharge: {
      unit: "cluster-hour",
      currency: "USD",
      tiers: [
        {
          from: addDay(standardEnd),
          rate: 0.5,
          label: "$0.50 per cluster-hour on top of the $0.10 standard fee",
        },
      ],
      pricingUrl: EKS_PRICING_URL,
      priceNote: "Same rate in every commercial region.",
    },
    upgradeUrl: EKS_UPGRADE_URL,
    note: `At the end of extended support EKS upgrades the control plane itself; node groups are left on the old version. Calendar: ${EKS_VERSIONS_URL}`,
  })),
};

// ─── RDS / Aurora ───────────────────────────────────────────────────────────

interface RdsRow {
  id: string;
  product: string;
  engines: string[];
  versions: string[];
  standardEnd: string;
  /** First billed day, when AWS granted a grace period after `standardEnd`. */
  billedFrom?: string;
  year3From: string;
  extendedEnd: string;
  target: string;
  upgradeUrl: string;
}

const RDS_CALENDAR: RdsRow[] = [
  {
    id: "mysql-5.7",
    product: "RDS for MySQL",
    engines: ["mysql"],
    versions: ["5.7"],
    standardEnd: "2024-02-29",
    year3From: "2026-03-01",
    extendedEnd: "2029-06-30",
    target: "MySQL 8.4",
    upgradeUrl: RDS_MYSQL_UPGRADE_URL,
  },
  {
    id: "mysql-8.0",
    product: "RDS for MySQL",
    engines: ["mysql"],
    versions: ["8.0"],
    standardEnd: "2026-07-31",
    year3From: "2028-08-01",
    extendedEnd: "2029-07-31",
    target: "MySQL 8.4",
    upgradeUrl: RDS_MYSQL_UPGRADE_URL,
  },
  ...(
    [
      ["11", "2024-02-29", "2024-04-01", "2026-04-01", "2027-03-31"],
      ["12", "2025-02-28", undefined, "2027-03-01", "2028-02-29"],
      ["13", "2026-02-28", undefined, "2028-03-01", "2029-02-28"],
      ["14", "2027-02-28", undefined, "2029-03-01", "2030-02-28"],
    ] as Array<[string, string, string | undefined, string, string]>
  ).flatMap(([major, standardEnd, billedFrom, year3From, extendedEnd]): RdsRow[] => [
    {
      id: `postgres-${major}`,
      product: "RDS for PostgreSQL",
      engines: ["postgres"],
      versions: [major],
      standardEnd,
      ...(billedFrom ? { billedFrom } : {}),
      year3From,
      extendedEnd,
      target: "PostgreSQL 17",
      upgradeUrl: RDS_POSTGRES_UPGRADE_URL,
    },
    {
      id: `aurora-postgresql-${major}`,
      product: "Aurora PostgreSQL",
      engines: ["aurora-postgresql"],
      versions: [major],
      standardEnd,
      ...(billedFrom ? { billedFrom } : {}),
      year3From,
      extendedEnd,
      target: "Aurora PostgreSQL 17",
      upgradeUrl: AURORA_POSTGRES_UPGRADE_URL,
    },
  ]),
  {
    id: "aurora-mysql-2",
    product: "Aurora MySQL",
    engines: ["aurora-mysql", "aurora"],
    // Aurora MySQL v2 reports `5.7.mysql_aurora.2.x`.
    versions: ["5.7"],
    standardEnd: "2024-10-31",
    billedFrom: "2024-12-01",
    year3From: "2026-12-01",
    extendedEnd: "2029-06-30",
    target: "Aurora MySQL version 3 (MySQL 8.0 compatible)",
    upgradeUrl: AURORA_MYSQL_UPGRADE_URL,
  },
];

export const RDS_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "engineVersion",
  engineFieldKey: "engine",
  quantityFieldKey: "vcpus",
  regionFieldKey: "region",
  chargedWhen: [
    { fieldKey: "engineLifecycleSupport", notIn: ["open-source-rds-extended-support-disabled"] },
  ],
  notChargedNote:
    "RDS Extended Support is disabled on this instance, so RDS upgrades its major version automatically instead of billing for it.",
  releases: RDS_CALENDAR.map((row): ExtendedSupportRelease => ({
    id: row.id,
    product: row.product,
    engines: row.engines,
    versions: row.versions,
    standardSupportEnds: row.standardEnd,
    extendedSupportEnds: row.extendedEnd,
    targetVersion: row.target,
    surcharge: {
      unit: "vcpu-hour",
      currency: "USD",
      tiers: [
        {
          from: row.billedFrom ?? addDay(row.standardEnd),
          rate: 0.1,
          label: "Years 1-2: $0.100 per vCPU-hour",
        },
        { from: row.year3From, rate: 0.2, label: "Year 3: $0.200 per vCPU-hour" },
      ],
      pricingUrl: RDS_PRICING_URL,
      priceNote: `${US_EAST_NOTE} Multi-AZ standbys are billed too; Aurora Serverless v2 is billed per ACU-hour and has no computed figure.`,
    },
    upgradeUrl: row.upgradeUrl,
  })),
};

/**
 * vCPUs for an RDS instance class (`db.r6g.2xlarge` → 8), which is what RDS
 * Extended Support bills on. Null for classes the size can't be read from
 * (`db.serverless`, `metal`), so the host shows no figure rather than a guess.
 */
export function rdsInstanceClassVcpus(instanceClass: string): number | null {
  const m = /^db\.([a-z0-9-]+)\.([a-z0-9]+)$/i.exec(instanceClass.trim());
  if (!m) return null;
  const family = m[1]!.toLowerCase();
  const size = m[2]!.toLowerCase();
  if (size === "micro" || size === "small") return family.startsWith("t2") ? 1 : 2;
  if (size === "medium") return family.startsWith("t") ? 2 : 1;
  if (size === "large") return 2;
  if (size === "xlarge") return 4;
  const multiple = /^(\d+)xlarge$/.exec(size);
  return multiple ? Number(multiple[1]) * 4 : null;
}

// ─── ElastiCache ────────────────────────────────────────────────────────────

export const ELASTICACHE_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "engineVersion",
  engineFieldKey: "engine",
  quantityFieldKey: "numNodes",
  regionFieldKey: "region",
  releases: (
    [
      ["4", "2026-01-31", "2028-02-01", "2029-01-31"],
      ["5", "2026-01-31", "2028-02-01", "2029-01-31"],
      ["6", "2027-01-31", "2029-02-01", "2030-01-31"],
    ] as Array<[string, string, string, string]>
  ).map(([major, standardEnd, year3From, extendedEnd]): ExtendedSupportRelease => ({
    id: `redis-${major}`,
    product: "ElastiCache for Redis OSS",
    engines: ["redis"],
    versions: [major],
    standardSupportEnds: standardEnd,
    extendedSupportEnds: extendedEnd,
    targetVersion: "Valkey 8",
    surcharge: {
      unit: "node-hour",
      currency: "USD",
      tiers: [
        { from: addDay(standardEnd), label: "Years 1-2: 80% of the node's on-demand price" },
        { from: year3From, label: "Year 3: 160% of the node's on-demand price" },
      ],
      pricingUrl: "https://aws.amazon.com/elasticache/pricing/",
      priceNote:
        "Priced as a premium on each node's on-demand rate, so only the billed amount can be shown.",
    },
    upgradeUrl: ELASTICACHE_UPGRADE_URL,
    note: `Reserved nodes pay the premium too. At the end of extended support ElastiCache upgrades the cache to Valkey. ${ELASTICACHE_URL}`,
  })),
};

// ─── OpenSearch ─────────────────────────────────────────────────────────────

/** Size factors AWS multiplies instance hours by to get normalized instance hours. */
const OPENSEARCH_SIZE_FACTORS: Record<string, number> = {
  nano: 0.25,
  micro: 0.5,
  small: 1,
  medium: 2,
  large: 4,
  xlarge: 8,
};

/**
 * Normalized instance units per hour for a domain's data nodes
 * (`r6g.large.search` x 3 → 12). Null when the size can't be read.
 */
export function openSearchNormalizedUnits(instanceType: string, count: number): number | null {
  const m = /^[a-z0-9-]+\.([a-z0-9]+)\.(search|elasticsearch)$/i.exec(instanceType.trim());
  if (!m || !(count > 0)) return null;
  const size = m[1]!.toLowerCase();
  const multiple = /^(\d+)xlarge$/.exec(size);
  const factor = multiple ? Number(multiple[1]) * 8 : OPENSEARCH_SIZE_FACTORS[size];
  return factor !== undefined ? factor * count : null;
}

function openSearchRelease(
  id: string,
  versions: string[],
  standardEnd: string,
  extendedEnd: string,
  instancePriceFrom?: string,
): ExtendedSupportRelease {
  return {
    id,
    product: "Amazon OpenSearch Service",
    versions,
    standardSupportEnds: standardEnd,
    extendedSupportEnds: extendedEnd,
    targetVersion: "OpenSearch 3.x",
    surcharge: {
      unit: "instance-hour",
      currency: "USD",
      tiers: [
        {
          from: addDay(standardEnd),
          rate: 0.0065,
          label: "$0.0065 per normalized instance hour",
        },
        ...(instancePriceFrom
          ? [
              {
                from: instancePriceFrom,
                label: "Final year: a surcharge equal to the instance price",
              },
            ]
          : []),
      ],
      pricingUrl: "https://aws.amazon.com/opensearch-service/pricing/",
      priceNote: `${US_EAST_NOTE} Counts data nodes only; dedicated master nodes are billed too.`,
    },
    upgradeUrl: OPENSEARCH_UPGRADE_URL,
    note: `Calendar: ${OPENSEARCH_URL}`,
  };
}

export const OPENSEARCH_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "engineVersion",
  quantityFieldKey: "normalizedInstanceUnits",
  regionFieldKey: "region",
  // Order matters (first match wins): the specific minors with later dates
  // come before the broad prefixes they would otherwise fall under.
  releases: [
    openSearchRelease("es-5.6", ["Elasticsearch_5.6"], "2025-11-07", "2028-11-07"),
    openSearchRelease(
      "es-6.8-7.10",
      ["Elasticsearch_6.8", "Elasticsearch_7.10"],
      "2027-11-07",
      "2030-11-07",
    ),
    openSearchRelease("es-7.9", ["Elasticsearch_7.9"], "2027-11-07", "2028-11-07"),
    openSearchRelease("os-1.3", ["OpenSearch_1.3"], "2027-11-07", "2030-11-07"),
    openSearchRelease("os-2.19", ["OpenSearch_2.19"], "2027-11-07", "2030-11-07"),
    openSearchRelease(
      "os-2.11-2.17",
      [
        "OpenSearch_2.11",
        "OpenSearch_2.13",
        "OpenSearch_2.15",
        "OpenSearch_2.17",
        "OpenSearch_2.12",
        "OpenSearch_2.14",
        "OpenSearch_2.16",
      ],
      "2027-11-07",
      "2028-11-07",
    ),
    openSearchRelease(
      "legacy-2025",
      [
        "Elasticsearch_1.5",
        "Elasticsearch_2.3",
        ...["5.1", "5.3", "5.5"].map((v) => `Elasticsearch_${v}`),
        ...["6.0", "6.2", "6.3", "6.4", "6.5", "6.7"].map((v) => `Elasticsearch_${v}`),
        ...["7.1", "7.4", "7.7", "7.8"].map((v) => `Elasticsearch_${v}`),
        ...["1.0", "1.1", "1.2"].map((v) => `OpenSearch_${v}`),
        ...["2.3", "2.5", "2.7", "2.9"].map((v) => `OpenSearch_${v}`),
      ],
      "2025-11-07",
      "2027-11-07",
      "2026-11-07",
    ),
  ],
};

function addDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

// ─── Billed charges (Cost Explorer) ─────────────────────────────────────────

const CE_URL = "https://ce.us-east-1.amazonaws.com/";

async function ce<T>(creds: AwsCredentials, target: string, body: unknown): Promise<T> {
  const res = await fetchSigned({
    method: "POST",
    url: CE_URL,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSInsightsIndexService.${target}`,
    },
    body: JSON.stringify(body),
    service: "ce",
    credentials: { ...creds, region: "us-east-1" },
  });
  return (await res.json()) as T;
}

/** Where an extended-support usage type belongs, from its documented shape. */
export function classifyExtendedSupportUsageType(
  usageType: string,
): Pick<ExtendedSupportCharge, "resourceTypeId" | "releaseId" | "engine"> {
  if (/AmazonEKS-Hours:extendedSupport$/i.test(usageType)) return { resourceTypeId: "eks-cluster" };
  const rds = /ExtendedSupport:(?:Yr1-Yr2|Yr3):(ASv2:)?([A-Za-z]+)([0-9.]+)$/.exec(usageType);
  if (!rds) return {};
  const [, , engineToken, version] = rds;
  const major = version!.replace(/\.0$/, "");
  switch (engineToken!.toLowerCase()) {
    case "mysql":
      return {
        resourceTypeId: "rds-instance",
        engine: "mysql",
        releaseId: `mysql-${version!.includes(".") ? version : `${version}.0`}`,
      };
    case "postgresql":
      return { resourceTypeId: "rds-instance", engine: "postgres", releaseId: `postgres-${major}` };
    case "auroramysql":
      return {
        resourceTypeId: "rds-instance",
        engine: "aurora-mysql",
        releaseId: `aurora-mysql-${major}`,
      };
    case "aurorapostgresql":
      return {
        resourceTypeId: "rds-instance",
        engine: "aurora-postgresql",
        releaseId: `aurora-postgresql-${major}`,
      };
    default:
      return {};
  }
}

/**
 * What AWS billed for extended support over `range`: Cost Explorer's
 * `GetDimensionValues` finds the account's usage types containing
 * "ExtendedSupport" / "extendedSupport", then one `GetCostAndUsage` groups
 * their cost by region and usage type. Usage types this module cannot place
 * (ElastiCache and OpenSearch publish none) come back without a resource
 * type, and the host lists them as unattributed rather than guessing.
 *
 * Needs `ce:GetDimensionValues` and `ce:GetCostAndUsage`. Cost Explorer bills
 * $0.01 per request, so this is at most a handful of requests per call.
 */
export async function fetchAwsExtendedSupportCharges(
  creds: AwsCredentials,
  range: { start: string; end: string },
): Promise<ExtendedSupportCharge[]> {
  const usageTypes = new Set<string>();
  for (const search of ["ExtendedSupport", "extendedSupport"]) {
    let token: string | undefined;
    do {
      const page = await ce<{
        DimensionValues?: Array<{ Value?: string }>;
        NextPageToken?: string;
      }>(creds, "GetDimensionValues", {
        TimePeriod: { Start: range.start, End: range.end },
        Dimension: "USAGE_TYPE",
        Context: "COST_AND_USAGE",
        SearchString: search,
        ...(token ? { NextPageToken: token } : {}),
      });
      for (const v of page.DimensionValues ?? []) {
        if (v.Value && /extendedsupport/i.test(v.Value)) usageTypes.add(v.Value);
      }
      token = page.NextPageToken;
    } while (token);
  }
  if (usageTypes.size === 0) return [];

  const totals = new Map<string, ExtendedSupportCharge>();
  let token: string | undefined;
  do {
    const page = await ce<{
      ResultsByTime?: Array<{
        Groups?: Array<{
          Keys?: string[];
          Metrics?: Record<string, { Amount?: string; Unit?: string }>;
        }>;
      }>;
      NextPageToken?: string;
    }>(creds, "GetCostAndUsage", {
      TimePeriod: { Start: range.start, End: range.end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      Filter: { Dimensions: { Key: "USAGE_TYPE", Values: [...usageTypes] } },
      GroupBy: [
        { Type: "DIMENSION", Key: "REGION" },
        { Type: "DIMENSION", Key: "USAGE_TYPE" },
      ],
      ...(token ? { NextPageToken: token } : {}),
    });
    for (const result of page.ResultsByTime ?? []) {
      for (const group of result.Groups ?? []) {
        const [region, usageType] = group.Keys ?? [];
        const metric = group.Metrics?.["UnblendedCost"];
        const amount = Number(metric?.Amount ?? 0);
        if (!usageType || !Number.isFinite(amount) || amount <= 0) continue;
        const key = `${region ?? ""}\u0000${usageType}`;
        const existing = totals.get(key);
        if (existing) {
          existing.amount += amount;
          continue;
        }
        totals.set(key, {
          ...classifyExtendedSupportUsageType(usageType),
          ...(region && region !== "global" && region !== "NoRegion" ? { region } : {}),
          lineItem: usageType,
          amount,
          currency: metric?.Unit ?? "USD",
        });
      }
    }
    token = page.NextPageToken;
  } while (token);
  return [...totals.values()];
}
