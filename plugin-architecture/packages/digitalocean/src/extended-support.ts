/**
 * DigitalOcean end-of-life calendars for DOKS and Managed Databases.
 *
 * DigitalOcean sells no paid extension: a version past end of life is
 * upgraded for you, in the cluster's maintenance window. These declarations
 * therefore carry no surcharge; they put the forced-upgrade date on the
 * extended-support findings and the expiry radar so nobody meets it in the
 * maintenance window. Checked on 2026-10-04 against:
 *
 * - DOKS: https://docs.digitalocean.com/products/kubernetes/details/supported-releases/
 *   (auto-upgraded to the next minor 30 days after end of support).
 * - PostgreSQL: https://docs.digitalocean.com/products/databases/postgresql/details/limits/
 * - MongoDB: https://docs.digitalocean.com/products/databases/mongodb/details/limits/
 * - Kafka: https://docs.digitalocean.com/products/databases/kafka/details/limits/
 *
 * MySQL is deliberately absent: 8.0 reaches end of life on 2026-10-30 (forced
 * to 8.4), but the API reports the major version as `8` for both, so a rule
 * would flag 8.4 clusters too. Valkey and OpenSearch have no published dates.
 */
import type { ExtendedSupportDeclaration, ExtendedSupportRelease } from "@infrawrench/plugin-base";

const DOKS_URL = "https://docs.digitalocean.com/products/kubernetes/details/supported-releases/";
const DOKS_UPGRADE_URL =
  "https://docs.digitalocean.com/products/kubernetes/how-to/upgrade-cluster/";
const PG_UPGRADE_URL =
  "https://docs.digitalocean.com/products/databases/postgresql/how-to/upgrade-version/";
const PG_URL = "https://docs.digitalocean.com/products/databases/postgresql/details/limits/";
const MONGO_URL = "https://docs.digitalocean.com/products/databases/mongodb/details/limits/";
const KAFKA_URL = "https://docs.digitalocean.com/products/databases/kafka/details/limits/";

/** [version, last day of support, forced-upgrade date]. */
const DOKS_CALENDAR: Array<[string, string, string]> = [
  ["1.30", "2025-06-28", "2025-07-27"],
  ["1.31", "2025-10-28", "2025-11-27"],
  ["1.32", "2026-02-28", "2026-03-27"],
  ["1.33", "2026-06-28", "2026-07-27"],
  ["1.34", "2026-10-27", "2026-11-26"],
  ["1.35", "2027-02-28", "2027-03-28"],
];

export const DOKS_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "version",
  regionFieldKey: "region",
  releases: DOKS_CALENDAR.map(([version, supportEnd, forcedUpgrade]): ExtendedSupportRelease => ({
    id: `k8s-${version}`,
    product: "DigitalOcean Kubernetes",
    versions: [version],
    standardSupportEnds: supportEnd,
    extendedSupportEnds: forcedUpgrade,
    targetVersion: "1.35",
    upgradeUrl: DOKS_UPGRADE_URL,
    note: `No paid extension: DigitalOcean upgrades the cluster to the next minor version 30 days after end of support. Calendar: ${DOKS_URL}`,
  })),
};

function eol(
  id: string,
  product: string,
  engine: string,
  version: string,
  lastSupportedDay: string,
  target: string,
  docsUrl: string,
): ExtendedSupportRelease {
  return {
    id,
    product,
    engines: [engine],
    versions: [version],
    standardSupportEnds: lastSupportedDay,
    targetVersion: target,
    upgradeUrl: engine === "pg" ? PG_UPGRADE_URL : docsUrl,
    note: `No paid extension: DigitalOcean upgrades the cluster in its maintenance window once the version reaches end of life. ${docsUrl}`,
  };
}

export const MANAGED_DATABASE_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "version",
  engineFieldKey: "engine",
  regionFieldKey: "region",
  releases: [
    eol("pg-12", "Managed PostgreSQL", "pg", "12", "2024-11-13", "PostgreSQL 17", PG_URL),
    eol("pg-14", "Managed PostgreSQL", "pg", "14", "2026-11-11", "PostgreSQL 17", PG_URL),
    eol("pg-15", "Managed PostgreSQL", "pg", "15", "2027-11-11", "PostgreSQL 17", PG_URL),
    eol("mongodb-6.0", "Managed MongoDB", "mongodb", "6.0", "2025-10-30", "MongoDB 8.0", MONGO_URL),
    eol("kafka-3.5", "Managed Kafka", "kafka", "3.5", "2024-07-30", "Kafka 3.9", KAFKA_URL),
    eol("kafka-3.6", "Managed Kafka", "kafka", "3.6", "2024-10-17", "Kafka 3.9", KAFKA_URL),
    eol("kafka-3.7", "Managed Kafka", "kafka", "3.7", "2026-02-08", "Kafka 3.9", KAFKA_URL),
    eol("kafka-3.8", "Managed Kafka", "kafka", "3.8", "2026-07-31", "Kafka 3.9", KAFKA_URL),
  ],
};
