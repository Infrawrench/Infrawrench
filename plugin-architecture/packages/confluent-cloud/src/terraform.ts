import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Confluent Cloud: provider `confluentinc/confluent`.
 *
 * Argument names verified against the provider's own docs
 * (confluentinc/terraform-provider-confluent `docs/resources/*.md`, release
 * 2.88.0, 2026-10):
 * - `confluent_environment`: `display_name`, `stream_governance { package }`;
 *   import `env-…`.
 * - `confluent_kafka_cluster`: `display_name`, `availability`, `cloud`,
 *   `region`, `environment { id }`, optional `network { id }`, and exactly
 *   one of `basic`/`standard`/`enterprise`/`freight` (each with an optional
 *   `max_ecku`) or `dedicated { cku }`; import `env-…/lkc-…`.
 * - `confluent_flink_compute_pool`: `display_name`, `cloud`, `region`,
 *   `max_cfu`, `environment { id }`; import `env-…/lfcp-…`.
 * - `confluent_service_account`: `display_name`, `description`; import `sa-…`.
 *
 * Connectors are left out: their configuration holds credentials the
 * inventory never stores. API keys are credentials, not configuration.
 */

function num(resource: ResourceInstance, key: string): number | undefined {
  const raw = resource.fields[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  return raw === undefined || raw === "" || !Number.isFinite(n) ? undefined : n;
}

function envBlock(resource: ResourceInstance): TerraformValue | undefined {
  const env = fieldString(resource, "environmentId");
  return env ? tf.block({ id: tf.str(env) }) : undefined;
}

function mapCluster(resource: ResourceInstance): TerraformExportResult | null {
  const env = envBlock(resource);
  const type = fieldString(resource, "clusterType").toLowerCase();
  const cloud = fieldString(resource, "cloud");
  const region = fieldString(resource, "region");
  const availability = fieldString(resource, "availability");
  if (!env || !type || !cloud || !region || !availability) return null;
  const attributes: Record<string, TerraformValue> = {
    display_name: tf.str(fieldString(resource, "name") || resource.displayName),
    availability: tf.str(availability),
    cloud: tf.str(cloud),
    region: tf.str(region),
    environment: env,
  };
  if (type === "dedicated") {
    const cku = num(resource, "cku");
    if (cku === undefined) return null;
    attributes["dedicated"] = tf.block({ cku: tf.num(cku) });
  } else if (["basic", "standard", "enterprise", "freight"].includes(type)) {
    const maxEcku = num(resource, "maxEcku");
    attributes[type] = tf.block(maxEcku !== undefined ? { max_ecku: tf.num(maxEcku) } : {});
  } else {
    return null;
  }
  const network = fieldString(resource, "networkId");
  if (network) attributes["network"] = tf.block({ id: tf.str(network) });
  const clusterId = fieldString(resource, "clusterId") || resource.externalId || "";
  return {
    resource: {
      type: "confluent_kafka_cluster",
      name: resource.displayName,
      attributes,
      importId: `${fieldString(resource, "environmentId")}/${clusterId}`,
      comments: [
        "Dedicated zone placement and BYOK settings are not carried over.",
        "Import first and review `terraform plan` before applying.",
      ],
    },
  };
}

export const confluentTerraformExport: TerraformExportCapability = {
  provider: { name: "confluent", source: "confluentinc/confluent", version: "~> 2.0" },
  providerConfig: {
    cloud_api_key: tf.ref("var.confluent_cloud_api_key"),
    cloud_api_secret: tf.ref("var.confluent_cloud_api_secret"),
  },
  variables: [
    { name: "confluent_cloud_api_key", description: "Confluent Cloud API key", sensitive: true },
    {
      name: "confluent_cloud_api_secret",
      description: "Confluent Cloud API secret",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "environment",
    "kafka-cluster",
    "flink-compute-pool",
    "service-account",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "environment": {
        const attributes: Record<string, TerraformValue> = {
          display_name: tf.str(fieldString(resource, "name") || resource.displayName),
        };
        const pkg = fieldString(resource, "streamGovernance");
        if (pkg) attributes["stream_governance"] = tf.block({ package: tf.str(pkg) });
        return {
          resource: {
            type: "confluent_environment",
            name: resource.displayName,
            attributes,
            importId: fieldString(resource, "environmentId") || resource.externalId,
          },
        };
      }
      case "kafka-cluster":
        return mapCluster(resource);
      case "flink-compute-pool": {
        const env = envBlock(resource);
        const maxCfu = num(resource, "maxCfu");
        const cloud = fieldString(resource, "cloud");
        const region = fieldString(resource, "region");
        if (!env || maxCfu === undefined || !cloud || !region) return null;
        const poolId = fieldString(resource, "poolId") || resource.externalId || "";
        return {
          resource: {
            type: "confluent_flink_compute_pool",
            name: resource.displayName,
            attributes: {
              display_name: tf.str(fieldString(resource, "name") || resource.displayName),
              cloud: tf.str(cloud),
              region: tf.str(region),
              max_cfu: tf.num(maxCfu),
              environment: env,
            },
            importId: `${fieldString(resource, "environmentId")}/${poolId}`,
          },
        };
      }
      case "service-account": {
        const attributes: Record<string, TerraformValue> = {
          display_name: tf.str(fieldString(resource, "name") || resource.displayName),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return {
          resource: {
            type: "confluent_service_account",
            name: resource.displayName,
            attributes,
            importId: fieldString(resource, "serviceAccountId") || resource.externalId,
          },
        };
      }
      default:
        return null;
    }
  },
};
