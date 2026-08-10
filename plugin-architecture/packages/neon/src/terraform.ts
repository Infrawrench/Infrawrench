import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Neon — community provider `kislerdm/neon`.
 * Attribute names verified against Neon docs + provider registry
 * (registry.terraform.io/providers/kislerdm/neon, neon.com/docs/reference/terraform):
 *   - neon_project: `name` required; `region_id`, `pg_version` optional.
 *   - neon_branch: `project_id`, `name` required; `parent_id`, `protected` optional.
 *   - neon_endpoint: `project_id`, `branch_id` required; autoscaling + suspend optional.
 *   - neon_database: `project_id`, `branch_id`, `name` required.
 *   - neon_role: `project_id`, `branch_id`, `name` required.
 * Import IDs: project/branch/endpoint by id; branch composite `projectId/branchId`;
 * role composite `projectId/branchId/roleName`; database `projectId/branchId/dbName`.
 * The API key is always `var.neon_api_key` — never inlined.
 */
export const neonTerraformExport: TerraformExportCapability = {
  provider: { name: "neon", source: "kislerdm/neon", version: "~> 0.6" },
  providerConfig: { api_key: tf.ref("var.neon_api_key") },
  variables: [
    {
      name: "neon_api_key",
      description: "Neon API key (console.neon.tech → Account Settings → API Keys)",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "neon-project",
    "neon-branch",
    "neon-endpoint",
    "neon-database",
    "neon-role",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "neon-project": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const region = fieldString(resource, "region");
        if (region) attributes["region_id"] = tf.str(region);
        const pgVersion = fieldNumber(resource, "pgVersion");
        if (pgVersion !== undefined) attributes["pg_version"] = tf.num(pgVersion);
        return {
          resource: {
            type: "neon_project",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "neon-branch": {
        const name = fieldString(resource, "name") || resource.displayName;
        const projectId = fieldString(resource, "projectId");
        if (!name || !projectId) return null;
        const attributes: Record<string, TerraformValue> = {
          project_id: tf.str(projectId),
          name: tf.str(name),
        };
        if (fieldBool(resource, "protected")) attributes["protected"] = tf.str("yes");
        const branchId = resource.externalId ?? "";
        const importId = branchId ? `${projectId}/${branchId}` : undefined;
        return {
          resource: {
            type: "neon_branch",
            name,
            attributes,
            ...(importId ? { importId } : {}),
          },
        };
      }
      case "neon-endpoint": {
        const projectId = fieldString(resource, "projectId");
        const branchId = fieldString(resource, "branchId");
        if (!projectId || !branchId) return null;
        const attributes: Record<string, TerraformValue> = {
          project_id: tf.str(projectId),
          branch_id: tf.str(branchId),
        };
        const type = fieldString(resource, "type");
        if (type) attributes["type"] = tf.str(type);
        const minCu = fieldNumber(resource, "autoscalingMinCu");
        if (minCu !== undefined) attributes["autoscaling_limit_min_cu"] = tf.num(minCu);
        const maxCu = fieldNumber(resource, "autoscalingMaxCu");
        if (maxCu !== undefined) attributes["autoscaling_limit_max_cu"] = tf.num(maxCu);
        const suspend = fieldNumber(resource, "suspendTimeout");
        if (suspend !== undefined) attributes["suspend_timeout_seconds"] = tf.num(suspend);
        const host = fieldString(resource, "host") || resource.displayName;
        return {
          resource: {
            type: "neon_endpoint",
            name: host || `${projectId}-${branchId}`,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "neon-database": {
        const name = fieldString(resource, "name") || resource.displayName;
        const projectId = fieldString(resource, "projectId");
        const branchId = fieldString(resource, "branchId");
        if (!name || !projectId || !branchId) return null;
        const attributes: Record<string, TerraformValue> = {
          project_id: tf.str(projectId),
          branch_id: tf.str(branchId),
          name: tf.str(name),
        };
        const owner = fieldString(resource, "ownerName");
        if (owner) attributes["owner_name"] = tf.str(owner);
        return {
          resource: {
            type: "neon_database",
            name,
            attributes,
            importId: `${projectId}/${branchId}/${name}`,
          },
        };
      }
      case "neon-role": {
        const name = fieldString(resource, "name") || resource.displayName;
        const projectId = fieldString(resource, "projectId");
        const branchId = fieldString(resource, "branchId");
        if (!name || !projectId || !branchId) return null;
        const attributes: Record<string, TerraformValue> = {
          project_id: tf.str(projectId),
          branch_id: tf.str(branchId),
          name: tf.str(name),
        };
        if (fieldBool(resource, "protected")) attributes["protected"] = tf.str("yes");
        return {
          resource: {
            type: "neon_role",
            name,
            attributes,
            importId: `${projectId}/${branchId}/${name}`,
            comments: [
              "Role passwords are not exported — rotate credentials after import if needed.",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};
