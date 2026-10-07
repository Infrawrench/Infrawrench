import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Better Stack Uptime: provider
 * `BetterStackHQ/better-uptime`.
 *
 * Attribute names verified against the provider's docs
 * (BetterStackHQ/terraform-provider-better-uptime `docs/resources/*.md`,
 * release v0.22.4, 2026-10). Most resources import by id; status page
 * sections import as `status_page_id/id`. The provider takes `api_token`.
 *
 * Mapped: monitors, monitor and heartbeat groups, heartbeats, status pages,
 * status page sections and on-call calendars. Escalation policies need their
 * full step tree, status page resources and reports carry state the
 * inventory does not keep, and Telemetry objects belong to the separate
 * `BetterStackHQ/logtail` provider, which one export cannot mix in.
 */
const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function team(attrs: Record<string, TerraformValue>, value: string) {
  if (value) attrs["team_name"] = tf.str(value);
}

export const betterStackTerraformExport: TerraformExportCapability = {
  provider: { name: "betteruptime", source: "BetterStackHQ/better-uptime", version: "~> 0.22" },
  providerConfig: { api_token: tf.ref("var.betteruptime_api_token") },
  variables: [
    {
      name: "betteruptime_api_token",
      description: "Better Stack Uptime or global API token",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "monitor",
    "monitor-group",
    "heartbeat-group",
    "heartbeat",
    "status-page",
    "status-page-section",
    "on-call-calendar",
  ],
  mapResource(resource): TerraformExportResult | null {
    const id = resource.externalId;
    const name = fieldString(resource, "name") || resource.displayName;
    switch (resource.resourceTypeId) {
      case "monitor": {
        const type = fieldString(resource, "monitorType");
        const url = fieldString(resource, "url");
        if (!type || (!url && type !== "playwright")) return null;
        const attributes: Record<string, TerraformValue> = { monitor_type: tf.str(type) };
        if (url) attributes["url"] = tf.str(url);
        if (fieldString(resource, "name"))
          attributes["pronounceable_name"] = tf.str(fieldString(resource, "name"));
        const freq = fieldNumber(resource, "checkFrequency");
        if (freq !== undefined) attributes["check_frequency"] = tf.num(freq);
        const timeout = fieldNumber(resource, "requestTimeout");
        if (timeout !== undefined) attributes["request_timeout"] = tf.num(timeout);
        const regions = csv(fieldString(resource, "regions"));
        if (regions.length) attributes["regions"] = tf.list(regions.map((r) => tf.str(r)));
        if (typeof resource.fields["verifySsl"] === "boolean")
          attributes["verify_ssl"] = tf.bool(resource.fields["verifySsl"]);
        if (resource.fields["paused"] === true) attributes["paused"] = tf.bool(true);
        const policy = fieldString(resource, "policyId");
        if (policy) attributes["policy_id"] = tf.str(policy);
        team(attributes, fieldString(resource, "team"));
        return {
          resource: { type: "betteruptime_monitor", name: name || url, attributes, importId: id },
        };
      }
      case "monitor-group":
      case "heartbeat-group": {
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (resource.fields["paused"] === true) attributes["paused"] = tf.bool(true);
        team(attributes, fieldString(resource, "team"));
        const type =
          resource.resourceTypeId === "monitor-group"
            ? "betteruptime_monitor_group"
            : "betteruptime_heartbeat_group";
        return { resource: { type, name, attributes, importId: id } };
      }
      case "heartbeat": {
        const period = fieldNumber(resource, "period");
        const grace = fieldNumber(resource, "grace");
        if (!name || period === undefined || grace === undefined) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          period: tf.num(period),
          grace: tf.num(grace),
        };
        if (resource.fields["paused"] === true) attributes["paused"] = tf.bool(true);
        team(attributes, fieldString(resource, "team"));
        return { resource: { type: "betteruptime_heartbeat", name, attributes, importId: id } };
      }
      case "status-page": {
        const company = fieldString(resource, "companyName");
        const subdomain = fieldString(resource, "subdomain");
        const timezone = fieldString(resource, "timezone");
        if (!company || !subdomain || !timezone) return null;
        const attributes: Record<string, TerraformValue> = {
          company_name: tf.str(company),
          subdomain: tf.str(subdomain),
          timezone: tf.str(timezone),
        };
        for (const [field, attr] of [
          ["companyUrl", "company_url"],
          ["customDomain", "custom_domain"],
        ] as const) {
          const v = fieldString(resource, field);
          if (v) attributes[attr] = tf.str(v);
        }
        const history = fieldNumber(resource, "history");
        if (history !== undefined) attributes["history"] = tf.num(history);
        if (typeof resource.fields["published"] === "boolean")
          attributes["published"] = tf.bool(resource.fields["published"]);
        return {
          resource: { type: "betteruptime_status_page", name: company, attributes, importId: id },
        };
      }
      case "status-page-section": {
        const pageId = fieldString(resource, "statusPageId");
        if (!name || !pageId) return null;
        const attributes: Record<string, TerraformValue> = {
          status_page_id: tf.str(pageId),
          name: tf.str(name),
        };
        const position = fieldNumber(resource, "position");
        if (position !== undefined) attributes["position"] = tf.num(position);
        return {
          resource: { type: "betteruptime_status_page_section", name, attributes, importId: id },
        };
      }
      case "on-call-calendar": {
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        team(attributes, fieldString(resource, "team"));
        return {
          resource: { type: "betteruptime_on_call_calendar", name, attributes, importId: id },
        };
      }
      default:
        return null;
    }
  },
};
