/**
 * Azure extended support: AKS Long Term Support and the Azure Database for
 * MySQL / PostgreSQL flexible server extended-support charge.
 *
 * Checked against Microsoft's pages on 2026-10-04; refresh when a version row
 * or a price changes:
 *
 * - AKS: https://learn.microsoft.com/azure/aks/supported-kubernetes-versions
 *   and https://learn.microsoft.com/azure/aks/long-term-support. A version
 *   past community support only keeps receiving patches on Long Term Support,
 *   which needs the Premium tier and `supportPlan: AKSLongTermSupport`; it is
 *   opt-in, never automatic. Premium bills $0.60 per cluster-hour against the
 *   Standard tier's $0.10 (https://azure.microsoft.com/pricing/details/kubernetes-service/),
 *   so the surcharge an upgrade removes is the $0.50 difference, assuming the
 *   cluster would keep the Standard tier's uptime SLA. Clusters not on LTS
 *   fall to "platform support" and are auto-upgraded when they would drop to
 *   N-4. Microsoft publishes the AKS calendar as months; the dates below are
 *   each month's last day.
 * - MySQL: https://learn.microsoft.com/azure/mysql/concepts-version-policy.
 * - PostgreSQL: https://learn.microsoft.com/azure/postgresql/configure-maintain/extended-support.
 *   Both bill $0.07 per vCore-hour in East US (other regions are higher),
 *   flat for the whole extended period; stopped servers are not billed, and
 *   the only way out is a major version upgrade.
 */
import type { ExtendedSupportDeclaration, ExtendedSupportRelease } from "@infrawrench/plugin-base";

const AKS_VERSIONS_URL = "https://learn.microsoft.com/azure/aks/supported-kubernetes-versions";
const AKS_UPGRADE_URL = "https://learn.microsoft.com/azure/aks/upgrade-aks-cluster";
const AKS_PRICING_URL = "https://azure.microsoft.com/pricing/details/kubernetes-service/";
const MYSQL_POLICY_URL = "https://learn.microsoft.com/azure/mysql/concepts-version-policy";
const MYSQL_UPGRADE_URL = "https://learn.microsoft.com/azure/mysql/flexible-server/how-to-upgrade";
const POSTGRES_POLICY_URL =
  "https://learn.microsoft.com/azure/postgresql/configure-maintain/extended-support";
const POSTGRES_UPGRADE_URL =
  "https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-major-version-upgrade";

function addDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** [version, end of community support, end of Long Term Support]. */
const AKS_CALENDAR: Array<[string, string, string]> = [
  ["1.27", "2024-07-31", "2025-07-31"],
  ["1.28", "2025-01-31", "2026-02-28"],
  ["1.29", "2025-03-31", "2026-04-30"],
  ["1.30", "2025-08-22", "2026-07-31"],
  ["1.31", "2025-10-31", "2026-11-30"],
  ["1.32", "2026-03-31", "2027-03-31"],
  ["1.33", "2026-07-31", "2027-07-31"],
  ["1.34", "2026-11-30", "2027-11-30"],
  ["1.35", "2027-03-31", "2028-03-31"],
];

export const AKS_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "kubernetesVersion",
  regionFieldKey: "location",
  chargedWhen: [{ fieldKey: "supportPlan", in: ["AKSLongTermSupport"] }],
  notChargedNote:
    "This cluster is not on Long Term Support, so past community support it only gets platform support (no security patches) and AKS upgrades it when it would fall four versions behind.",
  releases: AKS_CALENDAR.map(([version, communityEnd, ltsEnd]): ExtendedSupportRelease => ({
    id: `k8s-${version}`,
    product: "Azure Kubernetes Service",
    versions: [version],
    standardSupportEnds: communityEnd,
    extendedSupportEnds: ltsEnd,
    targetVersion: "1.34",
    surcharge: {
      unit: "cluster-hour",
      currency: "USD",
      tiers: [
        {
          from: addDay(communityEnd),
          rate: 0.5,
          label: "Premium tier (Long Term Support): $0.60 per cluster-hour, $0.50 over Standard",
        },
      ],
      pricingUrl: AKS_PRICING_URL,
      priceNote: "Same rate in every region; assumes the Standard tier after upgrading.",
    },
    upgradeUrl: AKS_UPGRADE_URL,
    note: `Calendar: ${AKS_VERSIONS_URL}`,
  })),
};

function flexibleRelease(
  id: string,
  product: string,
  version: string,
  standardEnd: string,
  billedFrom: string,
  extendedEnd: string,
  target: string,
  pricingUrl: string,
  upgradeUrl: string,
): ExtendedSupportRelease {
  return {
    id,
    product,
    versions: [version],
    standardSupportEnds: standardEnd,
    extendedSupportEnds: extendedEnd,
    targetVersion: target,
    surcharge: {
      unit: "vcore-hour",
      currency: "USD",
      tiers: [{ from: billedFrom, rate: 0.07, label: "$0.07 per vCore-hour" }],
      pricingUrl,
      priceNote: "East US list price; other regions differ. Stopped servers are not billed.",
    },
    upgradeUrl,
  };
}

/** Stopped flexible servers accrue no extended-support charge. */
const NOT_STOPPED = [{ fieldKey: "state", notIn: ["Stopped", "Disabled"] }];

export const MYSQL_FLEXIBLE_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "version",
  quantityFieldKey: "billableVCores",
  regionFieldKey: "location",
  chargedWhen: NOT_STOPPED,
  notChargedNote:
    "The server is stopped, so no extended-support charge accrues while it stays off.",
  releases: [
    flexibleRelease(
      "mysql-5.7",
      "Azure Database for MySQL",
      "5.7",
      "2026-09-30",
      "2026-10-01",
      "2029-03-31",
      "MySQL 8.4",
      MYSQL_POLICY_URL,
      MYSQL_UPGRADE_URL,
    ),
    flexibleRelease(
      "mysql-8.0",
      "Azure Database for MySQL",
      "8.0",
      "2027-01-31",
      "2027-02-01",
      "2029-05-31",
      "MySQL 8.4",
      MYSQL_POLICY_URL,
      MYSQL_UPGRADE_URL,
    ),
  ],
};

export const POSTGRES_FLEXIBLE_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "version",
  quantityFieldKey: "billableVCores",
  regionFieldKey: "location",
  chargedWhen: NOT_STOPPED,
  notChargedNote:
    "The server is stopped, so no extended-support charge accrues while it stays off.",
  releases: (
    [
      // Billing for 11-13 began a month after standard support ended.
      ["11", "2026-07-31", "2026-09-01", "2027-03-31"],
      ["12", "2026-07-31", "2026-09-01", "2027-11-13"],
      ["13", "2026-07-31", "2026-09-01", "2028-11-12"],
      ["14", "2027-01-31", "2027-02-01", "2029-11-11"],
    ] as Array<[string, string, string, string]>
  ).map(([major, standardEnd, billedFrom, extendedEnd]) =>
    flexibleRelease(
      `postgres-${major}`,
      "Azure Database for PostgreSQL",
      major,
      standardEnd,
      billedFrom,
      extendedEnd,
      "PostgreSQL 16",
      POSTGRES_POLICY_URL,
      POSTGRES_UPGRADE_URL,
    ),
  ),
};

/**
 * vCores of a flexible-server SKU (`Standard_D4ds_v5` → 4, `Standard_B1ms`
 * → 1), 0 when the name does not carry one.
 */
export function flexibleSkuVCores(sku: string): number {
  const m = /^Standard_[A-Z]+?(\d+)/i.exec(sku.trim());
  return m ? Number(m[1]) : 0;
}
