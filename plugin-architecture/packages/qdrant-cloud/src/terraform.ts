import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for the official `qdrant/qdrant-cloud` provider (1.29,
 * docs/resources/*.md, verified 2026-10). Its nested settings are blocks
 * (`configuration { node_configuration { package_id } }`), not attribute
 * objects.
 *
 * - `qdrant-cloud_accounts_cluster`: `name`, `cloud_provider`, `cloud_region`
 *   (the hybrid environment id for hybrid clusters), `account_id`,
 *   `configuration { number_of_nodes, version, node_configuration { package_id },
 *   allowed_ip_source_ranges, restart_policy, rebalance_strategy,
 *   cluster_storage_configuration { storage_tier_type } }`. Import id: cluster id.
 * - `qdrant-cloud_accounts_backup_schedule`: `cluster_id`, `cron_expression`,
 *   `retention_period` (Go duration, `"168h"`). Import id `<cluster_id>/<schedule_id>`.
 * - `qdrant-cloud_accounts_hybrid_cloud_environment`: `name`,
 *   `configuration { namespace }`. Import id: environment id.
 *
 * Labels are a repeated block the generic HCL renderer cannot express, and
 * extra disk is a `resource_configurations` triple the inventory does not keep
 * in that form; both are flagged in comments rather than exported wrong.
 */

const ACCOUNT = tf.ref("var.qdrant_cloud_account_id");

function enumValue(prefix: string, raw: string): TerraformValue | undefined {
  return raw ? tf.str(`${prefix}${raw}`) : undefined;
}

export const qdrantTerraformExport: TerraformExportCapability = {
  provider: { name: "qdrant-cloud", source: "qdrant/qdrant-cloud", version: "~> 1.29" },
  providerConfig: {
    api_key: tf.ref("var.qdrant_cloud_api_key"),
    account_id: ACCOUNT,
  },
  variables: [
    { name: "qdrant_cloud_api_key", description: "Qdrant Cloud management key", sensitive: true },
    { name: "qdrant_cloud_account_id", description: "Qdrant Cloud account ID" },
  ],
  supportedResourceTypeIds: ["cluster", "backup-schedule", "hybrid-environment"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "cluster": {
        const provider = fieldString(resource, "cloudProvider");
        const region = fieldString(resource, "region");
        const packageId = fieldString(resource, "packageId");
        const nodes = fieldNumber(resource, "nodes");
        if (!provider || !region || !packageId || nodes === undefined) return null;
        const configuration: Record<string, TerraformValue> = {
          number_of_nodes: tf.num(nodes),
          node_configuration: tf.block({ package_id: tf.str(packageId) }),
        };
        const version = fieldString(resource, "version");
        if (version) configuration["version"] = tf.str(version);
        const ranges = fieldString(resource, "allowedIpSourceRanges")
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);
        if (ranges.length) {
          configuration["allowed_ip_source_ranges"] = tf.list(ranges.map((r) => tf.str(r)));
        }
        const restart = enumValue(
          "CLUSTER_CONFIGURATION_RESTART_POLICY_",
          fieldString(resource, "restartPolicy"),
        );
        if (restart) configuration["restart_policy"] = restart;
        const rebalance = enumValue(
          "CLUSTER_CONFIGURATION_REBALANCE_STRATEGY_",
          fieldString(resource, "rebalanceStrategy"),
        );
        if (rebalance) configuration["rebalance_strategy"] = rebalance;
        const tier = enumValue("STORAGE_TIER_TYPE_", fieldString(resource, "storageTier"));
        if (tier) {
          configuration["cluster_storage_configuration"] = tf.block({ storage_tier_type: tier });
        }
        const comments = ["Import first and review `terraform plan` before applying."];
        if (fieldString(resource, "labels")) {
          comments.unshift(
            `Labels not exported, add them as labels blocks: ${fieldString(resource, "labels")}`,
          );
        }
        if ((fieldNumber(resource, "additionalDiskGib") ?? 0) > 0) {
          comments.unshift(
            `The cluster has ${fieldNumber(resource, "additionalDiskGib")} GiB of extra disk per node; set it under node_configuration.resource_configurations.`,
          );
        }
        return {
          resource: {
            type: "qdrant-cloud_accounts_cluster",
            name: fieldString(resource, "name") || resource.displayName,
            attributes: {
              name: tf.str(fieldString(resource, "name") || resource.displayName),
              account_id: ACCOUNT,
              cloud_provider: tf.str(provider),
              cloud_region: tf.str(region),
              configuration: tf.block(configuration),
            },
            importId: fieldString(resource, "clusterId") || resource.externalId,
            comments,
          },
        };
      }
      case "backup-schedule": {
        const clusterId = fieldString(resource, "clusterId");
        const cron = fieldString(resource, "schedule");
        if (!clusterId || !cron) return null;
        const attributes: Record<string, TerraformValue> = {
          account_id: ACCOUNT,
          cluster_id: tf.str(clusterId),
          cron_expression: tf.str(cron),
        };
        const days = fieldNumber(resource, "retentionDays");
        if (days !== undefined) attributes["retention_period"] = tf.str(`${days * 24}h`);
        return {
          resource: {
            type: "qdrant-cloud_accounts_backup_schedule",
            name: resource.displayName,
            attributes,
            importId: `${clusterId}/${fieldString(resource, "scheduleId") || resource.externalId}`,
          },
        };
      }
      case "hybrid-environment": {
        const namespace = fieldString(resource, "namespace");
        if (!namespace) return null;
        return {
          resource: {
            type: "qdrant-cloud_accounts_hybrid_cloud_environment",
            name: resource.displayName,
            attributes: {
              name: tf.str(fieldString(resource, "name") || resource.displayName),
              account_id: ACCOUNT,
              configuration: tf.block({ namespace: tf.str(namespace) }),
            },
            importId: fieldString(resource, "environmentId") || resource.externalId,
          },
        };
      }
      default:
        return null;
    }
  },
};
