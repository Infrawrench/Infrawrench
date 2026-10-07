import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Infisical: the official `Infisical/infisical`
 * provider (registry.terraform.io/providers/Infisical/infisical, 0.16.x,
 * attribute names checked against the registry docs 2026-10):
 *   - infisical_project: name, slug, description, type, has_delete_protection.
 *     Import id: the project id.
 *   - infisical_project_environment: name, slug, project_id, position.
 *     Import id: the environment id.
 *   - infisical_secret_folder: name, environment_slug, folder_path, project_id.
 *     No import support in the provider.
 *   - infisical_secret: name, env_slug, folder_path, workspace_id, value
 *     (always `var.*`, never inlined). No import support.
 *   - infisical_identity: name, org_id, role, has_delete_protection.
 *     Import id: the identity id. `org_id` comes from a variable because the
 *     stored inventory does not carry it.
 * Syncs, dynamic secrets, CAs and certificates need provider-specific
 * configuration the inventory does not store, so they are not exported.
 */
export const infisicalTerraformExport: TerraformExportCapability = {
  provider: { name: "infisical", source: "Infisical/infisical", version: "~> 0.16" },
  providerConfig: {
    host: tf.ref("var.infisical_host"),
    auth: tf.block({
      universal: tf.block({
        client_id: tf.ref("var.infisical_client_id"),
        client_secret: tf.ref("var.infisical_client_secret"),
      }),
    }),
  },
  variables: [
    { name: "infisical_host", description: "Infisical URL, e.g. https://app.infisical.com" },
    {
      name: "infisical_client_id",
      description: "Machine identity Universal Auth client ID",
      sensitive: true,
    },
    {
      name: "infisical_client_secret",
      description: "Machine identity Universal Auth client secret",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["project", "environment", "folder", "secret", "machine-identity"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "project": {
        const name = fieldString(resource, "name");
        const slug = fieldString(resource, "slug");
        if (!name || !slug) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          slug: tf.str(slug),
          type: tf.str(fieldString(resource, "type") || "secret-manager"),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        if (fieldBool(resource, "hasDeleteProtection"))
          attributes["has_delete_protection"] = tf.bool(true);
        return {
          resource: {
            type: "infisical_project",
            name: slug,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "environment": {
        const name = fieldString(resource, "name");
        const slug = fieldString(resource, "slug");
        const projectId = fieldString(resource, "projectId");
        if (!name || !slug || !projectId) return null;
        const attributes: Record<string, TerraformValue> = {
          project_id: tf.str(projectId),
          name: tf.str(name),
          slug: tf.str(slug),
        };
        const position = fieldNumber(resource, "position");
        if (position !== undefined) attributes["position"] = tf.num(position);
        const envId = (resource.externalId ?? "").split("/")[1];
        return {
          resource: {
            type: "infisical_project_environment",
            name: `${fieldString(resource, "projectSlug") || projectId}_${slug}`,
            attributes,
            ...(envId ? { importId: envId } : {}),
          },
        };
      }
      case "folder": {
        const name = fieldString(resource, "name");
        const path = fieldString(resource, "path");
        const env = fieldString(resource, "environment");
        const projectId = fieldString(resource, "projectId");
        if (!name || !path || !env || !projectId) return null;
        const parent = path.slice(0, Math.max(1, path.lastIndexOf("/"))) || "/";
        return {
          resource: {
            type: "infisical_secret_folder",
            name: `${env}${path}`,
            attributes: {
              project_id: tf.str(projectId),
              environment_slug: tf.str(env),
              folder_path: tf.str(parent),
              name: tf.str(name),
            },
            comments: [
              "The provider cannot import folders: the first apply adopts the existing folder by path.",
            ],
          },
        };
      }
      case "secret": {
        const key = fieldString(resource, "key");
        const env = fieldString(resource, "environment");
        const projectId = fieldString(resource, "projectId");
        if (!key || !env || !projectId) return null;
        const variable = `infisical_secret_${env}_${key}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
        return {
          resource: {
            type: "infisical_secret",
            name: `${env}_${key}`,
            attributes: {
              workspace_id: tf.str(projectId),
              env_slug: tf.str(env),
              folder_path: tf.str(fieldString(resource, "path") || "/"),
              name: tf.str(key),
              value: tf.ref(`var.${variable}`),
            },
            comments: [`Set var.${variable} before apply; secret values are never inlined.`],
          },
          variables: [
            {
              name: variable,
              description: `Value of Infisical secret ${key} (${env})`,
              sensitive: true,
            },
          ],
        };
      }
      case "machine-identity": {
        const name = fieldString(resource, "name");
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          org_id: tf.ref("var.infisical_org_id"),
          role: tf.str(fieldString(resource, "role") || "no-access"),
        };
        if (fieldBool(resource, "hasDeleteProtection"))
          attributes["has_delete_protection"] = tf.bool(true);
        return {
          resource: { type: "infisical_identity", name, attributes, importId: resource.externalId },
          variables: [{ name: "infisical_org_id", description: "Infisical organization ID" }],
        };
      }
      default:
        return null;
    }
  },
};
