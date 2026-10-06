import type { TerraformExportCapability, TerraformValue } from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for incident.io: provider `incident-io/incident`, `api_key`.
 * Verified against the provider's docs (github.com/incident-io/terraform-provider-incident,
 * docs/resources, 2026-10):
 *   - incident_severity: `name` and `description` required, `rank` optional.
 * Schedules, escalation paths, alert sources and routes, and workflows are
 * not exported: their configuration (rotations, path nodes, templates, steps)
 * is not synced here, and a block written without it would replace the real
 * one on apply. Catalog types need `source_repo_url`, which the API does not
 * return. Incidents are not configuration.
 */
export const incidentIoTerraformExport: TerraformExportCapability = {
  provider: { name: "incident", source: "incident-io/incident", version: "~> 5.0" },
  providerConfig: { api_key: tf.ref("var.incident_io_api_key") },
  variables: [
    {
      name: "incident_io_api_key",
      description: "incident.io API key (Settings, API keys)",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["incident-io-severity"],
  mapResource(resource) {
    if (resource.resourceTypeId !== "incident-io-severity") return null;
    const name = fieldString(resource, "name") || resource.displayName;
    if (!name) return null;
    const attributes: Record<string, TerraformValue> = {
      name: tf.str(name),
      description: tf.str(fieldString(resource, "description") || name),
    };
    const rank = fieldNumber(resource, "rank");
    if (rank !== undefined) attributes["rank"] = tf.num(rank);
    return {
      resource: { type: "incident_severity", name, attributes, importId: resource.externalId },
    };
  },
};
