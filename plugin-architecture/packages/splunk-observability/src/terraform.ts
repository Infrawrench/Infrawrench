import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Splunk Observability Cloud: provider
 * `splunk-terraform/signalfx`. Attribute names verified against the
 * provider's docs (`docs/resources/detector.md`, `team.md`,
 * `dashboard_group.md`, 2026-10): every resource imports by its string id,
 * and the provider takes `auth_token` plus `api_url` for the realm.
 *
 * Detectors export their program and rules; rule notifications are not in
 * the stored inventory, so they are left for the user to add. Dashboards and
 * charts are whole visual documents the inventory does not carry.
 */
export const splunkTerraformExport: TerraformExportCapability = {
  provider: { name: "signalfx", source: "splunk-terraform/signalfx", version: "~> 9.0" },
  providerConfig: {
    auth_token: tf.ref("var.signalfx_auth_token"),
    api_url: tf.ref("var.signalfx_api_url"),
  },
  variables: [
    {
      name: "signalfx_auth_token",
      description: "Splunk Observability Cloud API access token",
      sensitive: true,
    },
    {
      name: "signalfx_api_url",
      description: "API URL of your realm, e.g. https://api.us1.observability.splunkcloud.com",
    },
  ],
  supportedResourceTypeIds: ["detector", "team", "dashboard-group"],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    if (!name) return null;
    const description = fieldString(resource, "description");
    if (resource.resourceTypeId === "team") {
      return {
        resource: {
          type: "signalfx_team",
          name,
          attributes: {
            name: tf.str(name),
            ...(description ? { description: tf.str(description) } : {}),
          },
          importId: resource.externalId,
          comments: ["Members and notification policies are not exported."],
        },
      };
    }
    if (resource.resourceTypeId === "dashboard-group") {
      return {
        resource: {
          type: "signalfx_dashboard_group",
          name,
          attributes: { name: tf.str(name), description: tf.str(description) },
          importId: resource.externalId,
        },
      };
    }
    if (resource.resourceTypeId === "detector") {
      const program = fieldString(resource, "programText");
      if (!program) return null;
      let rules: Array<{
        detectLabel?: string;
        severity?: string;
        description?: string;
        disabled?: boolean;
      }> = [];
      try {
        rules = JSON.parse(fieldString(resource, "rulesJson") || "[]");
      } catch {
        rules = [];
      }
      if (rules.length === 0) return null;
      const attributes: Record<string, TerraformValue> = {
        name: tf.str(name),
        program_text: tf.str(program),
        ...(description ? { description: tf.str(description) } : {}),
      };
      const tags = fieldString(resource, "tags").split(", ").filter(Boolean);
      if (tags.length) attributes["tags"] = tf.list(tags.map((t) => tf.str(t)));
      // `rule` repeats; the serializer writes one key per attribute.
      attributes['dynamic "rule"'] = tf.block({
        for_each: tf.list(
          rules.map((r) =>
            tf.map({
              detect_label: tf.str(r.detectLabel ?? ""),
              severity: tf.str(r.severity ?? "Warning"),
              description: tf.str(r.description ?? ""),
              disabled: tf.bool(r.disabled === true),
            }),
          ),
        ),
        content: tf.block({
          detect_label: tf.ref("rule.value.detect_label"),
          severity: tf.ref("rule.value.severity"),
          description: tf.ref("rule.value.description"),
          disabled: tf.ref("rule.value.disabled"),
        }),
      });
      return {
        resource: {
          type: "signalfx_detector",
          name,
          attributes,
          importId: resource.externalId,
          comments: [
            "Rule notifications are not exported; add them before applying or alerts go nowhere.",
          ],
        },
      };
    }
    return null;
  },
};
