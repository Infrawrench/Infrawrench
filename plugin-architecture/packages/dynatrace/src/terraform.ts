import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import type { AlertingProfileValue } from "./mappers.js";

/**
 * Terraform mapping for Dynatrace: provider `dynatrace-oss/dynatrace`.
 *
 * Attribute names verified against the provider's docs
 * (`docs/resources/alerting.md`, `docs/resources/slo_v2.md`, 2026-10):
 *
 * - `dynatrace_alerting` (Settings 2.0 `builtin:alerting.profile`): `name`,
 *   `management_zone`, and `rules { rule { severity_level, delay_in_minutes,
 *   include_mode, tags } }`. Imported by the settings object id.
 * - `dynatrace_slo_v2` (`builtin:monitoring.slo`): `name`, `enabled`,
 *   `custom_description`, `evaluation_type`, `evaluation_window`, `filter`,
 *   `metric_expression`, `metric_name`, `target_success`, `target_warning`
 *   and a required `error_budget_burn_rate { burn_rate_visualization_enabled }`.
 *   The provider's read accepts the classic SLO UUID as the import id.
 *
 * Maintenance windows are not mapped: `dynatrace_maintenance` (the resource
 * for `builtin:alerting.maintenance-window`) is deprecated in the provider in
 * favour of `dynatrace_maintenance_windows`, which is a different schema.
 * Entities and problems are observed, not configured; synthetic monitors
 * carry scripts the inventory does not store.
 */
export const dynatraceTerraformExport: TerraformExportCapability = {
  provider: { name: "dynatrace", source: "dynatrace-oss/dynatrace", version: "~> 1.0" },
  providerConfig: {
    dt_env_url: tf.ref("var.dynatrace_env_url"),
    dt_api_token: tf.ref("var.dynatrace_api_token"),
  },
  variables: [
    { name: "dynatrace_env_url", description: "Dynatrace environment URL" },
    {
      name: "dynatrace_api_token",
      description: "Dynatrace access token with settings.read/write and slo.read/write",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["alerting-profile", "slo"],
  mapResource(resource): TerraformExportResult | null {
    if (resource.resourceTypeId === "alerting-profile") {
      const name = fieldString(resource, "name") || resource.displayName;
      if (!name) return null;
      let rules: NonNullable<AlertingProfileValue["severityRules"]> = [];
      try {
        rules = JSON.parse(fieldString(resource, "rulesJson") || "[]");
      } catch {
        rules = [];
      }
      const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
      const zone = fieldString(resource, "managementZone");
      if (zone) attributes["management_zone"] = tf.str(zone);
      if (rules.length > 0) {
        // `rule` repeats inside `rules`; the serializer writes one key per
        // attribute, so the repetition is a `dynamic` block.
        attributes["rules"] = tf.block({
          'dynamic "rule"': tf.block({
            for_each: tf.list(
              rules.map((r) =>
                tf.map({
                  severity_level: tf.str(r.severityLevel ?? "AVAILABILITY"),
                  delay_in_minutes: tf.num(r.delayInMinutes ?? 0),
                  include_mode: tf.str(r.tagFilterIncludeMode ?? "NONE"),
                  tags: tf.list((r.tagFilter ?? []).map((t) => tf.str(t))),
                }),
              ),
            ),
            content: tf.block({
              severity_level: tf.ref("rule.value.severity_level"),
              delay_in_minutes: tf.ref("rule.value.delay_in_minutes"),
              include_mode: tf.ref("rule.value.include_mode"),
              tags: tf.ref("rule.value.tags"),
            }),
          }),
        });
      }
      return {
        resource: {
          type: "dynatrace_alerting",
          name,
          attributes,
          importId: resource.externalId,
          comments:
            Number(resource.fields["eventFilterCount"] ?? 0) > 0
              ? [
                  "This profile has event filters, which are not exported. Add them before applying.",
                ]
              : [],
        },
      };
    }
    if (resource.resourceTypeId === "slo") {
      const name = fieldString(resource, "name") || resource.displayName;
      const expression = fieldString(resource, "metricExpression");
      const target = fieldNumber(resource, "target");
      const warning = fieldNumber(resource, "warning");
      if (!name || !expression || target === undefined || warning === undefined) return null;
      const attributes: Record<string, TerraformValue> = {
        name: tf.str(name),
        enabled: tf.bool(resource.fields["enabled"] !== false),
        evaluation_type: tf.str(fieldString(resource, "evaluationType") || "AGGREGATE"),
        evaluation_window: tf.str(fieldString(resource, "timeframe") || "-1w"),
        filter: tf.str(fieldString(resource, "filter")),
        metric_expression: tf.str(expression),
        target_success: tf.num(target),
        target_warning: tf.num(warning),
        error_budget_burn_rate: tf.block({ burn_rate_visualization_enabled: tf.bool(false) }),
      };
      const description = fieldString(resource, "description");
      if (description) attributes["custom_description"] = tf.str(description);
      const metricName = fieldString(resource, "metricName");
      if (metricName) attributes["metric_name"] = tf.str(metricName);
      return {
        resource: {
          type: "dynatrace_slo_v2",
          name,
          attributes,
          importId: resource.externalId,
        },
      };
    }
    return null;
  },
};
