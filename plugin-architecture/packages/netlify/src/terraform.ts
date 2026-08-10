import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Netlify — provider `netlify/netlify`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/netlify/netlify):
 *   - netlify_dns_zone: `name` required; `team_slug` optional when default team set.
 *   - netlify_dns_record: `zone_id`, `type`, `hostname`, `value` required.
 *   - netlify_environment_variable: `key` required; `site_id`, `values`/`secret_values`.
 * netlify_site is a data source only (no managed site resource) — skipped.
 * Deploys, forms, and build hooks are ephemeral/UI-managed — skipped.
 * The API token is `var.netlify_api_token`.
 */
export const netlifyTerraformExport: TerraformExportCapability = {
  provider: { name: "netlify", source: "netlify/netlify", version: "~> 0.4" },
  providerConfig: { token: tf.ref("var.netlify_api_token") },
  variables: [
    {
      name: "netlify_api_token",
      description: "Netlify personal access token",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["netlify-dns-zone", "netlify-dns-record", "netlify-env-var"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "netlify-dns-zone": {
        const name =
          fieldString(resource, "name") || fieldString(resource, "domain") || resource.displayName;
        if (!name) return null;
        return {
          resource: {
            type: "netlify_dns_zone",
            name,
            attributes: { name: tf.str(name) },
            importId: resource.externalId,
          },
        };
      }
      case "netlify-dns-record": {
        const zoneId = fieldString(resource, "zoneId");
        const type = fieldString(resource, "type");
        const hostname = fieldString(resource, "name") || resource.displayName;
        const value = fieldString(resource, "content");
        if (!zoneId || !type || !hostname || !value) return null;
        const attributes: Record<string, TerraformValue> = {
          zone_id: tf.str(zoneId),
          type: tf.str(type),
          hostname: tf.str(hostname),
          value: tf.str(value),
        };
        const ttl = fieldNumber(resource, "ttl");
        if (ttl !== undefined) attributes["ttl"] = tf.num(ttl);
        const priority = fieldNumber(resource, "priority");
        if (priority !== undefined && type === "MX") attributes["priority"] = tf.num(priority);
        const flag = fieldNumber(resource, "flag");
        if (flag !== undefined && type === "CAA") attributes["flag"] = tf.num(flag);
        const tag = fieldString(resource, "tag");
        if (tag && type === "CAA") attributes["tag"] = tf.str(tag);
        return {
          resource: {
            type: "netlify_dns_record",
            name: `${type} ${hostname}`,
            attributes,
            ...(resource.externalId ? { importId: `${zoneId}:${resource.externalId}` } : {}),
          },
        };
      }
      case "netlify-env-var": {
        const key = fieldString(resource, "key");
        const siteId = fieldString(resource, "siteId");
        if (!key || !siteId) return null;
        const attributes: Record<string, TerraformValue> = {
          site_id: tf.str(siteId),
          key: tf.str(key),
        };
        if (fieldBool(resource, "isSecret")) {
          attributes["secret_values"] = tf.list([
            tf.map({
              context: tf.str("all"),
              value: tf.ref("var.netlify_env_value"),
            }),
          ]);
        } else {
          attributes["values"] = tf.list([
            tf.map({
              context: tf.str("all"),
              value: tf.ref("var.netlify_env_value"),
            }),
          ]);
        }
        return {
          resource: {
            type: "netlify_environment_variable",
            name: key,
            attributes,
            comments: [
              "Set var.netlify_env_value before apply — secret values are never inlined.",
              "Import id: team_id:site_id:key (team_id from Netlify dashboard).",
            ],
          },
          variables: [
            {
              name: "netlify_env_value",
              description: `Value for Netlify env var ${key}`,
              sensitive: true,
            },
          ],
        };
      }
      default:
        return null;
    }
  },
};
