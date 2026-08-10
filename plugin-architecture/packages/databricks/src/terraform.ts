import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Databricks — provider `databricks/databricks`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/databricks/databricks):
 *   - databricks_cluster: `spark_version`, `node_type_id` required; `cluster_name`, workers optional.
 *   - databricks_sql_endpoint: `name`, `cluster_size` required.
 *   - databricks_job: `name` optional; tasks are not reconstructed from list metadata.
 *   - databricks_catalog: `name` required (metastore-level).
 *   - databricks_schema: `catalog_name`, `name` required.
 * Node-type catalog entries are skipped per guidance. Provider uses host + token variables.
 */
export const databricksTerraformExport: TerraformExportCapability = {
  provider: { name: "databricks", source: "databricks/databricks", version: "~> 1.0" },
  providerConfig: {
    host: tf.ref("var.databricks_host"),
    token: tf.ref("var.databricks_token"),
  },
  variables: [
    {
      name: "databricks_host",
      description: "Databricks workspace URL (https://…)",
    },
    {
      name: "databricks_token",
      description: "Databricks personal access token",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "databricks-cluster",
    "databricks-sql-warehouse",
    "databricks-job",
    "databricks-catalog",
    "databricks-schema",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "databricks-cluster": {
        const clusterName = fieldString(resource, "clusterName") || resource.displayName;
        const sparkVersion = fieldString(resource, "sparkVersion");
        const nodeTypeId = fieldString(resource, "nodeTypeId");
        if (!clusterName || !sparkVersion || !nodeTypeId) return null;
        const attributes: Record<string, TerraformValue> = {
          cluster_name: tf.str(clusterName),
          spark_version: tf.str(sparkVersion),
          node_type_id: tf.str(nodeTypeId),
        };
        const numWorkers = fieldNumber(resource, "numWorkers");
        if (numWorkers !== undefined) attributes["num_workers"] = tf.num(numWorkers);
        const driverNode = fieldString(resource, "driverNodeTypeId");
        if (driverNode) attributes["driver_node_type_id"] = tf.str(driverNode);
        const autoTerm = fieldNumber(resource, "autoterminationMinutes");
        if (autoTerm !== undefined) attributes["autotermination_minutes"] = tf.num(autoTerm);
        return {
          resource: {
            type: "databricks_cluster",
            name: clusterName,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "databricks-sql-warehouse": {
        const name = fieldString(resource, "name") || resource.displayName;
        const clusterSize = fieldString(resource, "clusterSize");
        if (!name || !clusterSize) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          cluster_size: tf.str(clusterSize),
        };
        const minClusters = fieldNumber(resource, "minNumClusters");
        if (minClusters !== undefined) attributes["min_num_clusters"] = tf.num(minClusters);
        const maxClusters = fieldNumber(resource, "maxNumClusters");
        if (maxClusters !== undefined) attributes["max_num_clusters"] = tf.num(maxClusters);
        const autoStop = fieldNumber(resource, "autoStopMinutes");
        if (autoStop !== undefined) attributes["auto_stop_mins"] = tf.num(autoStop);
        return {
          resource: {
            type: "databricks_sql_endpoint",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "databricks-job": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        return {
          resource: {
            type: "databricks_job",
            name,
            attributes: { name: tf.str(name) },
            importId: resource.externalId,
            comments: [
              "Job task definitions are not exported — add task blocks manually",
              "after import (notebook, pipeline, sql_task, etc.).",
            ],
          },
        };
      }
      case "databricks-catalog": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const owner = fieldString(resource, "owner");
        if (owner) attributes["owner"] = tf.str(owner);
        const comment = fieldString(resource, "comment");
        if (comment) attributes["comment"] = tf.str(comment);
        return {
          resource: {
            type: "databricks_catalog",
            name,
            attributes,
            importId: resource.externalId ?? name,
          },
        };
      }
      case "databricks-schema": {
        const name = fieldString(resource, "name") || resource.displayName;
        const catalogName = fieldString(resource, "catalogName");
        if (!name || !catalogName) return null;
        const attributes: Record<string, TerraformValue> = {
          catalog_name: tf.str(catalogName),
          name: tf.str(name),
        };
        const owner = fieldString(resource, "owner");
        if (owner) attributes["owner"] = tf.str(owner);
        const comment = fieldString(resource, "comment");
        if (comment) attributes["comment"] = tf.str(comment);
        return {
          resource: {
            type: "databricks_schema",
            name: `${catalogName}.${name}`,
            attributes,
            importId: resource.externalId ?? `${catalogName}.${name}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
