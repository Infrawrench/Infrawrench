import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Doppler's official `DopplerHQ/doppler` provider (1.21,
 * registry docs read 2026-10): projects (import by name), environments
 * (`<project>.<slug>`), branch configs (`<project>.<env>.<config>`; root
 * configs are created by their environment) and groups (by slug). Secrets are
 * not exported: `doppler_secret` would put every value in Terraform state.
 */
export const dopplerTerraformExport: TerraformExportCapability = {
  provider: { name: "doppler", source: "DopplerHQ/doppler", version: "~> 1.21" },
  providerConfig: { doppler_token: tf.ref("var.doppler_token") },
  variables: [
    {
      name: "doppler_token",
      description: "Doppler personal or service account token",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "doppler-project",
    "doppler-environment",
    "doppler-config",
    "doppler-group",
  ],
  mapResource(resource): TerraformExportResult | null {
    const s = (k: string) => fieldString(resource, k);
    switch (resource.resourceTypeId) {
      case "doppler-project": {
        const name = s("slug") || s("name");
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        return { resource: { type: "doppler_project", name, attributes, importId: name } };
      }
      case "doppler-environment": {
        if (!s("project") || !s("slug")) return null;
        return {
          resource: {
            type: "doppler_environment",
            name: `${s("project")}_${s("slug")}`,
            attributes: {
              project: tf.str(s("project")),
              slug: tf.str(s("slug")),
              name: tf.str(s("name") || s("slug")),
            },
            importId: `${s("project")}.${s("slug")}`,
          },
        };
      }
      case "doppler-config": {
        if (!s("project") || !s("name") || !s("environment") || fieldBool(resource, "root"))
          return null;
        const attributes: Record<string, TerraformValue> = {
          project: tf.str(s("project")),
          environment: tf.str(s("environment")),
          name: tf.str(s("name")),
        };
        if (resource.fields["inheritable"] !== undefined)
          attributes["inheritable"] = tf.bool(fieldBool(resource, "inheritable"));
        return {
          resource: {
            type: "doppler_config",
            name: `${s("project")}_${s("name")}`,
            attributes,
            importId: `${s("project")}.${s("environment")}.${s("name")}`,
          },
        };
      }
      case "doppler-group": {
        if (!s("name") || !resource.externalId) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(s("name")) };
        if (s("defaultProjectRole"))
          attributes["default_project_role"] = tf.str(s("defaultProjectRole"));
        return {
          resource: {
            type: "doppler_group",
            name: s("name"),
            attributes,
            importId: resource.externalId,
          },
        };
      }
      default:
        return null;
    }
  },
};
