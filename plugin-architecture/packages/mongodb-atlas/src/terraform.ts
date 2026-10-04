import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for MongoDB Atlas: provider `mongodb/mongodbatlas` 2.x.
 *
 * Verified against the provider's docs (mongodb/terraform-provider-mongodbatlas,
 * `docs/index.md`, `docs/resources/project.md`, `project_ip_access_list.md`,
 * `flex_cluster.md`, 2026-10): service account auth is `client_id` /
 * `client_secret`; `mongodbatlas_project` takes `name` + `org_id` and imports
 * by project id; `mongodbatlas_project_ip_access_list` takes `project_id` and
 * one of `cidr_block` / `ip_address` / `aws_security_group`, importing as
 * `<project_id>-<entry>`; `mongodbatlas_flex_cluster` takes `project_id`,
 * `name` and a `provider_settings` object, importing as
 * `<project_id>-<name>`.
 *
 * Dedicated clusters are not mapped: `mongodbatlas_advanced_cluster` needs
 * the full replication spec (every region's node counts, priorities and
 * hardware) and the inventory stores only the primary region's. Database
 * users are not mapped because their passwords are never readable.
 */
export const mongodbAtlasTerraformExport: TerraformExportCapability = {
  provider: { name: "mongodbatlas", source: "mongodb/mongodbatlas", version: "~> 2.0" },
  providerConfig: {
    client_id: tf.ref("var.mongodbatlas_client_id"),
    client_secret: tf.ref("var.mongodbatlas_client_secret"),
  },
  variables: [
    { name: "mongodbatlas_client_id", description: "Atlas service account client ID" },
    {
      name: "mongodbatlas_client_secret",
      description: "Atlas service account client secret",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["project", "ip-access-entry", "flex-cluster"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "project": {
        const groupId = fieldString(resource, "groupId");
        const orgId = fieldString(resource, "orgId");
        const name = fieldString(resource, "name") || resource.displayName;
        if (!groupId || !orgId || !name) return null;
        return {
          resource: {
            type: "mongodbatlas_project",
            name,
            attributes: { name: tf.str(name), org_id: tf.str(orgId) },
            importId: groupId,
          },
        };
      }
      case "ip-access-entry": {
        const groupId = fieldString(resource, "groupId");
        const entry = fieldString(resource, "entry");
        if (!groupId || !entry) return null;
        const attributes: Record<string, TerraformValue> = { project_id: tf.str(groupId) };
        if (entry.startsWith("sg-")) attributes["aws_security_group"] = tf.str(entry);
        else attributes["cidr_block"] = tf.str(entry.includes("/") ? entry : `${entry}/32`);
        const comment = fieldString(resource, "comment");
        if (comment) attributes["comment"] = tf.str(comment);
        return {
          resource: {
            type: "mongodbatlas_project_ip_access_list",
            name: `${fieldString(resource, "projectName") || groupId}-${entry}`,
            attributes,
            importId: `${groupId}-${entry}`,
          },
        };
      }
      case "flex-cluster": {
        const groupId = fieldString(resource, "groupId");
        const name = fieldString(resource, "name") || resource.displayName;
        const provider = fieldString(resource, "provider");
        const region = fieldString(resource, "region");
        if (!groupId || !name || !provider || !region) return null;
        const attributes: Record<string, TerraformValue> = {
          project_id: tf.str(groupId),
          name: tf.str(name),
          provider_settings: tf.map({
            backing_provider_name: tf.str(provider),
            region_name: tf.str(region),
          }),
        };
        if (resource.fields["terminationProtectionEnabled"] === true) {
          attributes["termination_protection_enabled"] = tf.bool(true);
        }
        return {
          resource: {
            type: "mongodbatlas_flex_cluster",
            name,
            attributes,
            importId: `${groupId}-${name}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
