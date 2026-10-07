import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Axiom: provider `axiomhq/axiom`.
 *
 * Attribute names verified against the provider's docs
 * (axiomhq/terraform-provider-axiom `docs/resources/*.md`, release v1.6.3,
 * 2026-10); every resource imports by its id. The provider takes `api_token`
 * and `base_url`.
 *
 * Mapped: datasets, virtual fields, monitors (APL monitors only) and
 * notifiers whose target the inventory keeps in full (email). Webhook-style
 * notifiers are stored with their URL redacted, and PagerDuty / Opsgenie keys
 * are never stored, so those become variables. Dashboards are whole chart
 * and layout documents the inventory does not carry; tokens cannot be
 * re-created with the same secret; users are not configuration.
 */

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function varName(prefix: string, name: string): string {
  return `${prefix}_${name.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase()}`;
}

export const axiomTerraformExport: TerraformExportCapability = {
  provider: { name: "axiom", source: "axiomhq/axiom", version: "~> 1.6" },
  providerConfig: { api_token: tf.ref("var.axiom_api_token") },
  variables: [{ name: "axiom_api_token", description: "Axiom API token", sensitive: true }],
  supportedResourceTypeIds: ["dataset", "virtual-field", "monitor", "notifier"],
  mapResource(resource): TerraformExportResult | null {
    const id = resource.externalId;
    switch (resource.resourceTypeId) {
      case "dataset": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        const kind = fieldString(resource, "kind");
        if (kind) attributes["kind"] = tf.str(kind);
        if (resource.fields["useRetentionPeriod"] === true) {
          attributes["use_retention_period"] = tf.bool(true);
          const days = fieldNumber(resource, "retentionDays");
          if (days !== undefined) attributes["retention_days"] = tf.num(days);
        }
        const mapFields = csv(fieldString(resource, "mapFields"));
        if (mapFields.length > 0)
          attributes["map_fields"] = tf.list(mapFields.map((m) => tf.str(m)));
        return { resource: { type: "axiom_dataset", name, attributes, importId: id } };
      }
      case "virtual-field": {
        const name = fieldString(resource, "name");
        const dataset = fieldString(resource, "dataset");
        const expression = fieldString(resource, "expression");
        if (!name || !dataset || !expression) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          dataset: tf.str(dataset),
          expression: tf.str(expression),
        };
        for (const k of ["description", "type", "unit"]) {
          const v = fieldString(resource, k);
          if (v) attributes[k] = tf.str(v);
        }
        return {
          resource: {
            type: "axiom_virtual_field",
            name: `${dataset}_${name}`,
            attributes,
            importId: id,
          },
        };
      }
      case "monitor": {
        const name = fieldString(resource, "name") || resource.displayName;
        const type = fieldString(resource, "type");
        const apl = fieldString(resource, "aplQuery");
        if (!name || !type || !apl) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          type: tf.str(type),
          apl_query: tf.str(apl),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        const operator = fieldString(resource, "operator");
        if (operator) attributes["operator"] = tf.str(operator);
        for (const [field, attr] of [
          ["threshold", "threshold"],
          ["intervalMinutes", "interval_minutes"],
          ["rangeMinutes", "range_minutes"],
        ] as const) {
          const v = fieldNumber(resource, field);
          if (v !== undefined) attributes[attr] = tf.num(v);
        }
        for (const [field, attr] of [
          ["alertOnNoData", "alert_on_no_data"],
          ["notifyByGroup", "notify_by_group"],
          ["notifyEveryRun", "notify_every_run"],
        ] as const) {
          if (resource.fields[field] === true) attributes[attr] = tf.bool(true);
        }
        const notifiers = csv(fieldString(resource, "notifierIds"));
        if (notifiers.length > 0)
          attributes["notifier_ids"] = tf.list(notifiers.map((n) => tf.str(n)));
        return {
          resource: {
            type: "axiom_monitor",
            name,
            attributes,
            importId: id,
            comments:
              notifiers.length > 0
                ? [
                    "notifier_ids are literal ids; point them at exported axiom_notifier blocks if you export those too.",
                  ]
                : [],
          },
        };
      }
      case "notifier": {
        const name = fieldString(resource, "name") || resource.displayName;
        const channel = fieldString(resource, "channel");
        if (!name || !channel) return null;
        const target = fieldString(resource, "target");
        let properties: Record<string, TerraformValue> | null = null;
        const variables: Array<{ name: string; description: string; sensitive: boolean }> = [];
        const secretVar = (prefix: string, description: string) => {
          const v = varName(prefix, name);
          variables.push({ name: v, description, sensitive: true });
          return tf.ref(`var.${v}`);
        };
        switch (channel) {
          case "email":
            properties = { email: tf.map({ emails: tf.list(csv(target).map((e) => tf.str(e))) }) };
            break;
          case "slack":
            properties = {
              slack: tf.map({
                slack_url: secretVar("axiom_slack_url", `Slack webhook URL for ${name}`),
              }),
            };
            break;
          case "webhook":
            properties = {
              webhook: tf.map({ url: secretVar("axiom_webhook_url", `Webhook URL for ${name}`) }),
            };
            break;
          case "discordWebhook":
            properties = {
              discord_webhook: tf.map({
                discord_webhook_url: secretVar(
                  "axiom_discord_webhook_url",
                  `Discord webhook URL for ${name}`,
                ),
              }),
            };
            break;
          case "pagerduty":
            properties = {
              pagerduty: tf.map({
                routing_key: secretVar(
                  "axiom_pagerduty_routing_key",
                  `PagerDuty routing key for ${name}`,
                ),
              }),
            };
            break;
          case "opsgenie":
            properties = {
              opsgenie: tf.map({
                api_key: secretVar("axiom_opsgenie_api_key", `Opsgenie API key for ${name}`),
                is_eu: tf.bool(target === "EU"),
              }),
            };
            break;
          default:
            return null;
        }
        return {
          resource: {
            type: "axiom_notifier",
            name,
            attributes: { name: tf.str(name), properties: tf.map(properties) },
            importId: id,
          },
          ...(variables.length > 0 ? { variables } : {}),
        };
      }
      default:
        return null;
    }
  },
};
