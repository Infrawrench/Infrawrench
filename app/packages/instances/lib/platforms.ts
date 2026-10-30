import { msg } from "gt-react";

/**
 * The AWS platforms the bulk pricing data covers. Keys match `PLATFORMS` in
 * `app/packages/web/src/aws-bulk-pricing/format.ts`, which is what the sync
 * writes to KV under.
 */
export interface PlatformInfo {
  /** Short name, as AWS writes it. */
  label: string;
  /** What the service is, in a few words (a `msg()` source). */
  summary: string;
  /** Preferred variant fields, most important first; the default variant matches as many as it can. */
  preferredVariant: Readonly<Record<string, string>>;
}

export const PLATFORMS: Readonly<Record<string, PlatformInfo>> = {
  ec2: {
    label: "EC2",
    summary: msg("Virtual servers"),
    preferredVariant: {
      operatingSystem: "Linux",
      tenancy: "Shared",
      capacitystatus: "Used",
      preInstalledSw: "NA",
      licenseModel: "No License required",
    },
  },
  rds: {
    label: "RDS",
    summary: msg("Managed relational databases"),
    preferredVariant: { databaseEngine: "PostgreSQL", deploymentOption: "Single-AZ" },
  },
  elasticache: {
    label: "ElastiCache",
    summary: msg("In-memory caches"),
    preferredVariant: { cacheEngine: "Redis" },
  },
  opensearch: {
    label: "OpenSearch",
    summary: msg("Search and log analytics"),
    preferredVariant: {},
  },
  redshift: { label: "Redshift", summary: msg("Data warehouse"), preferredVariant: {} },
  docdb: {
    label: "DocumentDB",
    summary: msg("MongoDB-compatible document database"),
    preferredVariant: {},
  },
  neptune: { label: "Neptune", summary: msg("Graph database"), preferredVariant: {} },
  memorydb: { label: "MemoryDB", summary: msg("Durable in-memory database"), preferredVariant: {} },
  dax: { label: "DAX", summary: msg("In-memory cache for DynamoDB"), preferredVariant: {} },
  sagemaker: { label: "SageMaker", summary: msg("Machine learning"), preferredVariant: {} },
  emr: { label: "EMR", summary: msg("Big data clusters"), preferredVariant: {} },
  gamelift: {
    label: "GameLift",
    summary: msg("Game servers"),
    preferredVariant: { operatingSystem: "Linux", isSpotInstance: "No" },
  },
};

export function platformInfo(platform: string): PlatformInfo | undefined {
  return Object.hasOwn(PLATFORMS, platform) ? PLATFORMS[platform] : undefined;
}

/** The region an instance page opens on, when the instance is offered there. */
export const DEFAULT_REGION_CODE = "us-east-1";
