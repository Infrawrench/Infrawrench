/**
 * Google Cloud extended support: the GKE Extended release channel and Cloud
 * SQL extended support.
 *
 * Checked against Google's pages on 2026-10-04; refresh when a version row or
 * a price changes:
 *
 * - GKE: https://cloud.google.com/kubernetes-engine/pricing#extended-support-period
 *   and https://cloud.google.com/kubernetes-engine/docs/release-schedule.
 *   Only clusters on the Extended channel stay on a version past standard
 *   support; they pay $0.50 per cluster-hour on top of the $0.10 management
 *   fee for that period, flat across regions. Clusters on any other channel
 *   are upgraded before standard support ends.
 * - Cloud SQL: https://cloud.google.com/sql/pricing (extended support) and
 *   https://cloud.google.com/sql/docs/db-versions. $0.07 per vCPU-hour in
 *   years 1-2 and $0.14 in year 3 in us-central1 (a high-availability vCPU
 *   counts twice), no committed-use discount; shared-core tiers are priced per
 *   instance instead and get no computed figure. Charges started 2025-05-01
 *   for the versions whose extended support began on 2025-02-01. At the end
 *   of extended support the instance is upgraded to the default major version.
 */
import type { ExtendedSupportDeclaration, ExtendedSupportRelease } from "@infrawrench/plugin-base";

const GKE_SCHEDULE_URL = "https://cloud.google.com/kubernetes-engine/docs/release-schedule";
const GKE_UPGRADE_URL =
  "https://cloud.google.com/kubernetes-engine/docs/how-to/upgrading-a-cluster";
const GKE_PRICING_URL =
  "https://cloud.google.com/kubernetes-engine/pricing#extended-support-period";
const CLOUDSQL_PRICING_URL = "https://cloud.google.com/sql/pricing";
const CLOUDSQL_MYSQL_UPGRADE_URL =
  "https://cloud.google.com/sql/docs/mysql/upgrade-major-db-version-inplace";
const CLOUDSQL_POSTGRES_UPGRADE_URL =
  "https://cloud.google.com/sql/docs/postgres/upgrade-major-db-version-inplace";

function addDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** [version, last day of standard support, last day of extended support]. */
const GKE_CALENDAR: Array<[string, string, string]> = [
  ["1.27", "2024-09-30", "2025-06-14"],
  ["1.28", "2025-02-03", "2026-01-09"],
  ["1.29", "2025-04-11", "2026-01-25"],
  ["1.30", "2025-09-29", "2026-07-30"],
  ["1.31", "2026-01-15", "2026-10-22"],
  ["1.32", "2026-04-26", "2027-02-11"],
  ["1.33", "2026-08-11", "2027-06-12"],
  ["1.34", "2027-01-24", "2027-11-25"],
  ["1.35", "2027-04-10", "2028-02-11"],
];

export const GKE_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "version",
  regionFieldKey: "location",
  chargedWhen: [{ fieldKey: "releaseChannel", in: ["EXTENDED"] }],
  notChargedNote:
    "This cluster is not on the Extended release channel, so GKE upgrades it before standard support ends instead of billing extended support.",
  releases: GKE_CALENDAR.map(([version, standardEnd, extendedEnd]): ExtendedSupportRelease => ({
    id: `k8s-${version}`,
    product: "Google Kubernetes Engine",
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
          label: "$0.50 per cluster-hour on top of the $0.10 management fee",
        },
      ],
      pricingUrl: GKE_PRICING_URL,
      priceNote: "Same rate in every region.",
    },
    upgradeUrl: GKE_UPGRADE_URL,
    note: `GKE starts upgrading Extended-channel clusters about two months before extended support ends. Calendar: ${GKE_SCHEDULE_URL}`,
  })),
};

interface CloudSqlRow {
  id: string;
  product: string;
  /** `databaseVersion` prefixes, e.g. `MYSQL_5_7`, `POSTGRES_12`. */
  versions: string[];
  standardEnd: string;
  billedFrom?: string;
  extendedEnd: string;
  target: string;
  upgradeUrl: string;
}

const CLOUDSQL_CALENDAR: CloudSqlRow[] = [
  {
    id: "mysql-5.6-5.7",
    product: "Cloud SQL for MySQL",
    versions: ["MYSQL_5_6", "MYSQL_5_7"],
    standardEnd: "2025-01-31",
    billedFrom: "2025-05-01",
    extendedEnd: "2028-01-31",
    target: "MySQL 8.4",
    upgradeUrl: CLOUDSQL_MYSQL_UPGRADE_URL,
  },
  {
    id: "mysql-8.0",
    product: "Cloud SQL for MySQL",
    versions: ["MYSQL_8_0"],
    standardEnd: "2026-12-31",
    extendedEnd: "2029-06-30",
    target: "MySQL 8.4",
    upgradeUrl: CLOUDSQL_MYSQL_UPGRADE_URL,
  },
  {
    id: "postgres-9.6-12",
    product: "Cloud SQL for PostgreSQL",
    versions: ["POSTGRES_9_6", "POSTGRES_10", "POSTGRES_11", "POSTGRES_12"],
    standardEnd: "2025-01-31",
    billedFrom: "2025-05-01",
    extendedEnd: "2028-01-31",
    target: "PostgreSQL 18",
    upgradeUrl: CLOUDSQL_POSTGRES_UPGRADE_URL,
  },
  {
    id: "postgres-13",
    product: "Cloud SQL for PostgreSQL",
    versions: ["POSTGRES_13"],
    standardEnd: "2026-01-31",
    extendedEnd: "2029-01-31",
    target: "PostgreSQL 18",
    upgradeUrl: CLOUDSQL_POSTGRES_UPGRADE_URL,
  },
  {
    id: "postgres-14",
    product: "Cloud SQL for PostgreSQL",
    versions: ["POSTGRES_14"],
    standardEnd: "2027-01-31",
    extendedEnd: "2030-01-31",
    target: "PostgreSQL 18",
    upgradeUrl: CLOUDSQL_POSTGRES_UPGRADE_URL,
  },
];

export const CLOUDSQL_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "databaseVersion",
  quantityFieldKey: "billableVcpus",
  regionFieldKey: "region",
  releases: CLOUDSQL_CALENDAR.map((row): ExtendedSupportRelease => {
    const start = addDay(row.standardEnd);
    const year3 = `${Number(start.slice(0, 4)) + 2}${start.slice(4)}`;
    return {
      id: row.id,
      product: row.product,
      versions: row.versions,
      standardSupportEnds: row.standardEnd,
      extendedSupportEnds: row.extendedEnd,
      targetVersion: row.target,
      surcharge: {
        unit: "vcpu-hour",
        currency: "USD",
        tiers: [
          {
            from: row.billedFrom ?? start,
            rate: 0.07,
            label: "Years 1-2: $0.07 per vCPU-hour",
          },
          { from: year3, rate: 0.14, label: "Year 3: $0.14 per vCPU-hour" },
        ],
        pricingUrl: CLOUDSQL_PRICING_URL,
        priceNote:
          "us-central1 list price; other regions differ. High-availability vCPUs count twice; shared-core tiers are priced per instance and get no computed figure.",
      },
      upgradeUrl: row.upgradeUrl,
    };
  }),
};

/**
 * vCPUs of a Cloud SQL tier (`db-custom-4-15360` → 4, `db-n1-standard-2` →
 * 2, `db-perf-optimized-N-8` → 8). 0 for shared-core tiers and anything
 * unrecognised, which leaves the computed figure empty.
 */
export function cloudSqlTierVcpus(tier: string): number {
  const t = tier.trim().toLowerCase();
  const custom = /^db-custom-(\d+)-\d+$/.exec(t);
  if (custom) return Number(custom[1]);
  const named = /^db-(?:n1|n2|e2|c3|c4a?)-(?:standard|highmem|highcpu)-(\d+)$/.exec(t);
  if (named) return Number(named[1]);
  const perf = /^db-perf-optimized-n-(\d+)$/.exec(t);
  return perf ? Number(perf[1]) : 0;
}
