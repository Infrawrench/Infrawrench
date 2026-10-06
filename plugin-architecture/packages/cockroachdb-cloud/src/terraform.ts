import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for CockroachDB Cloud: provider `cockroachdb/cockroach`
 * (1.23, September 2026). Attribute names and import ids verified against
 * github.com/cockroachdb/terraform-provider-cockroach/docs/resources:
 *   - cockroach_cluster: `name`, `cloud_provider`, `regions [{name,
 *     node_count?, primary?}]`, `plan`, `dedicated {num_virtual_cpus,
 *     storage_gib}`, `serverless {usage_limits {...}}`, `delete_protection`,
 *     `parent_id`, `backup_config {enabled, frequency_minutes,
 *     retention_days}`. Import: cluster id.
 *   - cockroach_database / cockroach_sql_user: import `{cluster}:{name}`.
 *     SQL user passwords use the write-only `password_wo`.
 *   - cockroach_allow_list: import `{cluster}:{ip}/{mask}`.
 *   - cockroach_folder, cockroach_service_account: import by id.
 * Provider auth is `apikey` (sensitive).
 */
export const cockroachTerraformExport: TerraformExportCapability = {
  provider: { name: "cockroach", source: "cockroachdb/cockroach", version: "~> 1.23" },
  providerConfig: { apikey: tf.ref("var.cockroach_api_key") },
  variables: [
    {
      name: "cockroach_api_key",
      description: "CockroachDB Cloud service account API key",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "crdb-cluster",
    "crdb-database",
    "crdb-sql-user",
    "crdb-allowlist-entry",
    "crdb-folder",
    "crdb-service-account",
  ],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    const ext = resource.externalId ?? "";
    switch (resource.resourceTypeId) {
      case "crdb-cluster": {
        const plan = fieldString(resource, "plan");
        const regions = fieldString(resource, "regions")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!regions.length) return null;
        const advanced = plan === "ADVANCED";
        const nodeCount = fieldNumber(resource, "nodeCount");
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          cloud_provider: tf.str(fieldString(resource, "cloudProvider")),
          regions: tf.list(
            regions.map((r, i) =>
              tf.map({
                name: tf.str(r),
                ...(advanced && nodeCount !== undefined ? { node_count: tf.num(nodeCount) } : {}),
                ...(!advanced && regions.length > 1 && i === 0 ? { primary: tf.bool(true) } : {}),
              }),
            ),
          ),
        };
        if (plan) attributes["plan"] = tf.str(plan);
        if (advanced) {
          const dedicated: Record<string, TerraformValue> = {};
          const vcpus = fieldNumber(resource, "vcpus");
          const storage = fieldNumber(resource, "storageGib");
          if (vcpus !== undefined) dedicated["num_virtual_cpus"] = tf.num(vcpus);
          if (storage !== undefined) dedicated["storage_gib"] = tf.num(storage);
          attributes["dedicated"] = tf.map(dedicated);
        } else {
          const limits: Record<string, TerraformValue> = {};
          const pv = fieldNumber(resource, "provisionedVcpus");
          const ru = fieldNumber(resource, "requestUnitLimit");
          const st = fieldNumber(resource, "storageMibLimit");
          if (pv !== undefined) limits["provisioned_virtual_cpus"] = tf.num(pv);
          if (ru !== undefined) limits["request_unit_limit"] = tf.num(ru);
          if (st !== undefined) limits["storage_mib_limit"] = tf.num(st);
          attributes["serverless"] = tf.map(
            Object.keys(limits).length ? { usage_limits: tf.map(limits) } : {},
          );
        }
        if (resource.fields["deleteProtection"] !== undefined) {
          attributes["delete_protection"] = tf.bool(fieldBool(resource, "deleteProtection"));
        }
        const folder = fieldString(resource, "folderId");
        if (folder) attributes["parent_id"] = tf.str(folder);
        if (resource.fields["backupsEnabled"] !== undefined) {
          const backup: Record<string, TerraformValue> = {
            enabled: tf.bool(fieldBool(resource, "backupsEnabled")),
          };
          const freq = fieldNumber(resource, "backupFrequencyMinutes");
          const ret = fieldNumber(resource, "backupRetentionDays");
          if (freq !== undefined) backup["frequency_minutes"] = tf.num(freq);
          if (ret !== undefined) backup["retention_days"] = tf.num(ret);
          attributes["backup_config"] = tf.map(backup);
        }
        return { resource: { type: "cockroach_cluster", name, attributes, importId: ext } };
      }
      case "crdb-database": {
        const cluster = fieldString(resource, "clusterId");
        if (!cluster) return null;
        return {
          resource: {
            type: "cockroach_database",
            name: `${cluster.slice(0, 8)}_${name}`,
            attributes: { cluster_id: tf.str(cluster), name: tf.str(name) },
            importId: `${cluster}:${name}`,
          },
        };
      }
      case "crdb-sql-user": {
        const cluster = fieldString(resource, "clusterId");
        if (!cluster) return null;
        const varName = `cockroach_sql_password_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        return {
          resource: {
            type: "cockroach_sql_user",
            name: `${cluster.slice(0, 8)}_${name}`,
            attributes: {
              cluster_id: tf.str(cluster),
              name: tf.str(name),
              password_wo: tf.ref(`var.${varName}`),
              password_wo_version: tf.num(1),
            },
            importId: `${cluster}:${name}`,
            comments: ["password_wo needs Terraform 1.11+; bump password_wo_version to rotate."],
          },
          variables: [
            { name: varName, description: `Password for SQL user ${name}`, sensitive: true },
          ],
        };
      }
      case "crdb-allowlist-entry": {
        const cluster = fieldString(resource, "clusterId");
        const cidr = fieldString(resource, "cidr");
        const [ip, mask] = cidr.split("/");
        if (!cluster || !ip || mask === undefined) return null;
        const attributes: Record<string, TerraformValue> = {
          cluster_id: tf.str(cluster),
          cidr_ip: tf.str(ip),
          cidr_mask: tf.num(Number(mask)),
          sql: tf.bool(fieldBool(resource, "sql")),
          ui: tf.bool(fieldBool(resource, "ui")),
        };
        const label = fieldString(resource, "name");
        if (label) attributes["name"] = tf.str(label);
        return {
          resource: {
            type: "cockroach_allow_list",
            name: label || cidr,
            attributes,
            importId: `${cluster}:${cidr}`,
          },
        };
      }
      case "crdb-folder":
        return {
          resource: {
            type: "cockroach_folder",
            name,
            attributes: {
              name: tf.str(name),
              parent_id: tf.str(fieldString(resource, "parentId") || "root"),
            },
            importId: ext,
          },
        };
      case "crdb-service-account": {
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const desc = fieldString(resource, "description");
        if (desc) attributes["description"] = tf.str(desc);
        return {
          resource: {
            type: "cockroach_service_account",
            name,
            attributes,
            importId: ext,
            comments: ["Roles are managed with cockroach_user_role_grant resources."],
          },
        };
      }
      default:
        return null;
    }
  },
};
