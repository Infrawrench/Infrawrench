import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/** Normalize stored cloud provider labels to TF enum (aws/gcp/azure). */
function clickhouseCloudProvider(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (lower === "aws" || lower.includes("amazon")) return "aws";
  if (lower === "gcp" || lower.includes("google")) return "gcp";
  if (lower === "azure" || lower.includes("microsoft")) return "azure";
  return null;
}

/**
 * Terraform mapping for ClickHouse Cloud — provider `ClickHouse/clickhouse`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/ClickHouse/clickhouse):
 *   - clickhouse_service: `name`, `cloud_provider`, `region` required;
 *     idle_scaling, min/max_replica_memory_gb, num_replicas optional.
 * Only ch-service is mapped — databases inside a service are not separate TF resources.
 * Cloud API credentials map to organization_id + token_key/token_secret.
 */
export const clickhouseTerraformExport: TerraformExportCapability = {
  provider: { name: "clickhouse", source: "ClickHouse/clickhouse", version: "~> 3.0" },
  providerConfig: {
    organization_id: tf.ref("var.clickhouse_organization_id"),
    token_key: tf.ref("var.clickhouse_api_key_id"),
    token_secret: tf.ref("var.clickhouse_api_key_secret"),
  },
  variables: [
    {
      name: "clickhouse_organization_id",
      description: "ClickHouse Cloud organization ID",
    },
    {
      name: "clickhouse_api_key_id",
      description: "ClickHouse Cloud API key ID",
    },
    {
      name: "clickhouse_api_key_secret",
      description: "ClickHouse Cloud API key secret",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["ch-service"],
  mapResource(resource): TerraformExportResult | null {
    if (resource.resourceTypeId !== "ch-service") return null;

    const name = fieldString(resource, "name") || resource.displayName;
    const region = fieldString(resource, "region");
    const providerRaw = fieldString(resource, "provider");
    const cloudProvider = providerRaw ? clickhouseCloudProvider(providerRaw) : null;
    if (!name || !region || !cloudProvider) return null;

    const attributes: Record<string, TerraformValue> = {
      name: tf.str(name),
      cloud_provider: tf.str(cloudProvider),
      region: tf.str(region),
      password_hash: tf.ref("var.clickhouse_service_password_hash"),
    };

    if (fieldBool(resource, "idleScaling")) attributes["idle_scaling"] = tf.bool(true);
    const idleTimeout = fieldNumber(resource, "idleTimeoutMinutes");
    if (idleTimeout !== undefined) attributes["idle_timeout_minutes"] = tf.num(idleTimeout);

    const minMem = fieldNumber(resource, "minReplicaMemoryGb");
    const maxMem = fieldNumber(resource, "maxReplicaMemoryGb");
    const numReplicas = fieldNumber(resource, "numReplicas");
    if (minMem !== undefined) attributes["min_replica_memory_gb"] = tf.num(minMem);
    if (maxMem !== undefined) attributes["max_replica_memory_gb"] = tf.num(maxMem);
    if (numReplicas !== undefined) attributes["num_replicas"] = tf.num(numReplicas);

    if (fieldBool(resource, "isReadonly")) attributes["readonly"] = tf.bool(true);

    return {
      resource: {
        type: "clickhouse_service",
        name,
        attributes,
        importId: fieldString(resource, "serviceId") || resource.externalId,
        comments: [
          "Set var.clickhouse_service_password_hash (sha256 of the default user password)",
          "— Infrawrench never exports SQL passwords inline.",
        ],
      },
      variables: [
        {
          name: "clickhouse_service_password_hash",
          description: "SHA-256 hash of the ClickHouse default user password",
          sensitive: true,
        },
      ],
    };
  },
};
