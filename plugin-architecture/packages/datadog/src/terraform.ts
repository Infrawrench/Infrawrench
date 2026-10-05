import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/** Threshold keys `datadog_monitor.monitor_thresholds` accepts. */
const THRESHOLD_KEYS = [
  "critical",
  "critical_recovery",
  "warning",
  "warning_recovery",
  "ok",
  "unknown",
] as const;

function thresholdsBlock(raw: string): TerraformValue | undefined {
  if (!raw) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const attributes: Record<string, TerraformValue> = {};
  for (const key of THRESHOLD_KEYS) {
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value)) attributes[key] = tf.num(value);
  }
  return Object.keys(attributes).length > 0 ? tf.block(attributes) : undefined;
}

/**
 * Terraform mapping for Datadog: provider `datadog/datadog`.
 *
 * Attribute names verified against the provider's own docs
 * (DataDog/terraform-provider-datadog `docs/resources/monitor.md` and
 * `docs/index.md`, release v4.24.0, 2026-10): `datadog_monitor` requires
 * `name`, `type`, `query` and `message`; `priority` is a string from "1" to
 * "5"; `tags` is a set of strings; `monitor_thresholds` is a single nested
 * block. The provider takes `api_key`, `app_key` and `api_url`.
 *
 * Only monitors are mapped. Dashboards and synthetic tests are whole JSON
 * documents the stored inventory does not carry, SLO and downtime rows lack
 * fields their resources require, and users and keys are not configuration.
 * Monitor options beyond the thresholds (renotify, no-data, evaluation delay)
 * are not stored either, so the comment above each block says to diff the
 * imported state before applying.
 */
export const datadogTerraformExport: TerraformExportCapability = {
  provider: { name: "datadog", source: "datadog/datadog", version: "~> 4.0" },
  providerConfig: {
    api_key: tf.ref("var.datadog_api_key"),
    app_key: tf.ref("var.datadog_app_key"),
    api_url: tf.ref("var.datadog_api_url"),
  },
  variables: [
    { name: "datadog_api_key", description: "Datadog API key", sensitive: true },
    { name: "datadog_app_key", description: "Datadog application key", sensitive: true },
    {
      name: "datadog_api_url",
      description: "API URL for your Datadog site, e.g. https://api.datadoghq.eu/",
    },
  ],
  supportedResourceTypeIds: ["monitor"],
  mapResource(resource): TerraformExportResult | null {
    if (resource.resourceTypeId !== "monitor") return null;
    const name = fieldString(resource, "name") || resource.displayName;
    const type = fieldString(resource, "type");
    const query = fieldString(resource, "query");
    if (!name || !type || !query) return null;
    const attributes: Record<string, TerraformValue> = {
      name: tf.str(name),
      type: tf.str(type),
      query: tf.str(query),
      message: tf.str(fieldString(resource, "message")),
    };
    const priority = fieldString(resource, "priority");
    if (priority) attributes["priority"] = tf.str(priority);
    const tags = fieldString(resource, "tags")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length > 0) attributes["tags"] = tf.list(tags.map((t) => tf.str(t)));
    const thresholds = thresholdsBlock(fieldString(resource, "thresholdsJson"));
    if (thresholds) attributes["monitor_thresholds"] = thresholds;
    return {
      resource: {
        type: "datadog_monitor",
        name,
        attributes,
        importId: resource.externalId,
        comments: [
          "Notification options other than thresholds (renotify, no-data, evaluation delay)",
          "are not carried over. Import first and review `terraform plan` before applying.",
        ],
      },
    };
  },
};
