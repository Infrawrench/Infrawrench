import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";
import { parseLabels } from "./mappers.js";

/**
 * Terraform mapping for Grafana Cloud: provider `grafana/grafana`.
 *
 * Attribute names verified against the provider's own docs
 * (grafana/terraform-provider-grafana `docs/resources/cloud_stack.md`,
 * release v4.47.0, 2026-10): `grafana_cloud_stack` requires `name` and
 * `slug`, and takes `region_slug`, `description`, `labels` (map of strings)
 * and `delete_protection`; the import id is the stack slug or id. The
 * provider authenticates Cloud resources with `cloud_access_policy_token`.
 *
 * Only stacks are mapped. Access policies carry realms and label policies the
 * stored inventory flattens to text, tokens cannot be imported with their
 * secret, and the stack-level objects (dashboards, alert rules) are whole JSON
 * documents the inventory does not carry.
 */
export const grafanaCloudTerraformExport: TerraformExportCapability = {
  provider: { name: "grafana", source: "grafana/grafana", version: "~> 4.0" },
  providerConfig: {
    cloud_access_policy_token: tf.ref("var.grafana_cloud_access_policy_token"),
  },
  variables: [
    {
      name: "grafana_cloud_access_policy_token",
      description: "Grafana Cloud access policy token with the stacks scopes",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["stack"],
  mapResource(resource): TerraformExportResult | null {
    if (resource.resourceTypeId !== "stack") return null;
    const slug = fieldString(resource, "slug") || resource.externalId || "";
    if (!slug) return null;
    const attributes: Record<string, TerraformValue> = {
      name: tf.str(fieldString(resource, "name") || resource.displayName || slug),
      slug: tf.str(slug),
    };
    const region = fieldString(resource, "region");
    if (region) attributes["region_slug"] = tf.str(region);
    const description = fieldString(resource, "description");
    if (description) attributes["description"] = tf.str(description);
    let labels: Record<string, string> = {};
    try {
      labels = parseLabels(fieldString(resource, "labels"));
    } catch {
      labels = {};
    }
    if (Object.keys(labels).length > 0) {
      attributes["labels"] = tf.map(
        Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, tf.str(v)])),
      );
    }
    attributes["delete_protection"] = tf.bool(resource.fields["deleteProtection"] === true);
    return {
      resource: {
        type: "grafana_cloud_stack",
        name: slug,
        attributes,
        importId: slug,
        comments: [
          "Changing region_slug destroys and recreates the stack. Import before applying.",
        ],
      },
    };
  },
};
