import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Checkly: provider `checkly/checkly`.
 *
 * Attribute names verified against the provider's docs
 * (checkly/terraform-provider-checkly `docs/resources/*.md`, release v1.29.0,
 * 2026-10). The provider takes `api_key` and `account_id`; resources import by
 * id.
 *
 * Mapped: URL and TCP monitors (whose target the inventory keeps in full),
 * check groups, dashboards, maintenance windows, private locations and
 * environment variables (secret values become variables). API, browser,
 * multistep and Playwright checks carry requests, assertions and scripts the
 * inventory does not store; alert channels carry secrets it never stores.
 */
const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const strList = (v: string) => tf.list(csv(v).map((s) => tf.str(s)));

function checkCommon(
  resource: Parameters<TerraformExportCapability["mapResource"]>[0],
): Record<string, TerraformValue> {
  const attrs: Record<string, TerraformValue> = {
    name: tf.str(fieldString(resource, "name") || resource.displayName),
    activated: tf.bool(resource.fields["activated"] !== false),
  };
  const freq = fieldNumber(resource, "frequency") ?? Number(fieldString(resource, "frequency"));
  if (Number.isFinite(freq)) attrs["frequency"] = tf.num(freq);
  if (resource.fields["muted"] === true) attrs["muted"] = tf.bool(true);
  if (fieldString(resource, "locations"))
    attrs["locations"] = strList(fieldString(resource, "locations"));
  if (fieldString(resource, "tags")) attrs["tags"] = strList(fieldString(resource, "tags"));
  const group = fieldNumber(resource, "groupId") ?? Number(fieldString(resource, "groupId"));
  if (fieldString(resource, "groupId") && Number.isFinite(group)) attrs["group_id"] = tf.num(group);
  for (const [field, attr] of [
    ["degradedResponseTime", "degraded_response_time"],
    ["maxResponseTime", "max_response_time"],
  ] as const) {
    const v = fieldNumber(resource, field);
    if (v !== undefined) attrs[attr] = tf.num(v);
  }
  return attrs;
}

export const checklyTerraformExport: TerraformExportCapability = {
  provider: { name: "checkly", source: "checkly/checkly", version: "~> 1.29" },
  providerConfig: {
    api_key: tf.ref("var.checkly_api_key"),
    account_id: tf.ref("var.checkly_account_id"),
  },
  variables: [
    { name: "checkly_api_key", description: "Checkly user API key", sensitive: true },
    { name: "checkly_account_id", description: "Checkly account ID" },
  ],
  supportedResourceTypeIds: [
    "check",
    "check-group",
    "dashboard",
    "maintenance-window",
    "private-location",
    "variable",
  ],
  mapResource(resource): TerraformExportResult | null {
    const id = resource.externalId;
    const name = fieldString(resource, "name") || resource.displayName;
    switch (resource.resourceTypeId) {
      case "check": {
        const type = fieldString(resource, "checkType");
        const target = fieldString(resource, "target");
        if (type === "URL" && /^https?:\/\//.test(target)) {
          return {
            resource: {
              type: "checkly_url_monitor",
              name,
              attributes: { ...checkCommon(resource), request: tf.block({ url: tf.str(target) }) },
              importId: id,
            },
          };
        }
        if (type === "TCP") {
          const m = /^(.+):(\d+)$/.exec(target);
          if (!m) return null;
          return {
            resource: {
              type: "checkly_tcp_monitor",
              name,
              attributes: {
                ...checkCommon(resource),
                request: tf.block({ hostname: tf.str(m[1] ?? ""), port: tf.num(Number(m[2])) }),
              },
              importId: id,
            },
          };
        }
        return null;
      }
      case "check-group": {
        if (!name) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(name),
          activated: tf.bool(resource.fields["activated"] !== false),
          concurrency: tf.num(fieldNumber(resource, "concurrency") ?? 3),
        };
        if (resource.fields["muted"] === true) attrs["muted"] = tf.bool(true);
        if (fieldString(resource, "locations"))
          attrs["locations"] = strList(fieldString(resource, "locations"));
        if (fieldString(resource, "tags")) attrs["tags"] = strList(fieldString(resource, "tags"));
        return { resource: { type: "checkly_check_group", name, attributes: attrs, importId: id } };
      }
      case "dashboard": {
        const header = fieldString(resource, "header");
        const customUrl = fieldString(resource, "customUrl");
        if (!header || !customUrl) return null;
        const attrs: Record<string, TerraformValue> = {
          header: tf.str(header),
          custom_url: tf.str(customUrl),
        };
        if (fieldString(resource, "customDomain"))
          attrs["custom_domain"] = tf.str(fieldString(resource, "customDomain"));
        if (fieldString(resource, "description"))
          attrs["description"] = tf.str(fieldString(resource, "description"));
        if (fieldString(resource, "tags")) attrs["tags"] = strList(fieldString(resource, "tags"));
        const refresh = Number(fieldString(resource, "refreshRate"));
        if (Number.isFinite(refresh) && refresh > 0) attrs["refresh_rate"] = tf.num(refresh);
        if (resource.fields["isPrivate"] === true) attrs["is_private"] = tf.bool(true);
        return {
          resource: { type: "checkly_dashboard", name: header, attributes: attrs, importId: id },
        };
      }
      case "maintenance-window": {
        const startsAt = fieldString(resource, "startsAt");
        const endsAt = fieldString(resource, "endsAt");
        if (!name || !startsAt || !endsAt) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(name),
          starts_at: tf.str(startsAt),
          ends_at: tf.str(endsAt),
        };
        if (fieldString(resource, "repeatUnit"))
          attrs["repeat_unit"] = tf.str(fieldString(resource, "repeatUnit"));
        const interval = fieldNumber(resource, "repeatInterval");
        if (interval !== undefined) attrs["repeat_interval"] = tf.num(interval);
        if (fieldString(resource, "repeatEndsAt"))
          attrs["repeat_ends_at"] = tf.str(fieldString(resource, "repeatEndsAt"));
        if (fieldString(resource, "tags")) attrs["tags"] = strList(fieldString(resource, "tags"));
        return {
          resource: { type: "checkly_maintenance_windows", name, attributes: attrs, importId: id },
        };
      }
      case "private-location": {
        const slug = fieldString(resource, "slugName");
        if (!name || !slug) return null;
        return {
          resource: {
            type: "checkly_private_location",
            name,
            attributes: { name: tf.str(name), slug_name: tf.str(slug) },
            importId: id,
          },
        };
      }
      case "variable": {
        const key = fieldString(resource, "key");
        if (!key) return null;
        const visible = fieldString(resource, "visibleValue");
        const variable = `checkly_env_${key.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase()}`;
        const attrs: Record<string, TerraformValue> = {
          key: tf.str(key),
          value: visible ? tf.str(visible) : tf.ref(`var.${variable}`),
        };
        if (resource.fields["locked"] === true) attrs["locked"] = tf.bool(true);
        if (resource.fields["secret"] === true) attrs["secret"] = tf.bool(true);
        return {
          resource: {
            type: "checkly_environment_variable",
            name: key,
            attributes: attrs,
            importId: key,
          },
          ...(visible
            ? {}
            : {
                variables: [
                  {
                    name: variable,
                    description: `Value of the Checkly variable ${key}`,
                    sensitive: true,
                  },
                ],
              }),
        };
      }
      default:
        return null;
    }
  },
};
