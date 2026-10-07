import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Okta: the official `okta/okta` provider (7.x,
 * attributes checked against registry.terraform.io 2026-10). Every resource
 * below imports by its Okta id.
 *   - okta_user: login, email, first_name, last_name (+ display_name, title, department).
 *   - okta_group: name, description (Okta-mastered groups only).
 *   - okta_auth_server: name, audiences, description.
 *   - okta_network_zone: name, type = "IP", gateways, proxies, usage.
 *   - okta_event_hook: name, events, channel map (type/version/uri).
 *   - okta_domain: name, certificate_source_type.
 * Apps (one resource type per sign-on mode, with settings the inventory does
 * not hold), policies (rules live in separate resources), trusted origins
 * (scope blocks changed shape in 7.x) and API tokens (not manageable) are not
 * exported.
 */
function csv(value: string): TerraformValue {
  return tf.list(
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => tf.str(v)),
  );
}

export const oktaTerraformExport: TerraformExportCapability = {
  provider: { name: "okta", source: "okta/okta", version: "~> 7.0" },
  providerConfig: {
    org_name: tf.ref("var.okta_org_name"),
    base_url: tf.ref("var.okta_base_url"),
    api_token: tf.ref("var.okta_api_token"),
  },
  variables: [
    { name: "okta_org_name", description: "Okta org subdomain, e.g. acme for acme.okta.com" },
    {
      name: "okta_base_url",
      description: "Okta base domain: okta.com, oktapreview.com or okta-emea.com",
    },
    { name: "okta_api_token", description: "Okta API token", sensitive: true },
  ],
  supportedResourceTypeIds: [
    "user",
    "group",
    "authorization-server",
    "network-zone",
    "event-hook",
    "domain",
  ],
  mapResource(resource): TerraformExportResult | null {
    const importId = resource.externalId;
    switch (resource.resourceTypeId) {
      case "user": {
        const login = fieldString(resource, "login");
        if (!login) return null;
        const attributes: Record<string, TerraformValue> = {
          login: tf.str(login),
          email: tf.str(fieldString(resource, "email")),
          first_name: tf.str(fieldString(resource, "firstName")),
          last_name: tf.str(fieldString(resource, "lastName")),
        };
        for (const [field, attr] of [
          ["displayName", "display_name"],
          ["title", "title"],
          ["department", "department"],
        ] as const) {
          const value = fieldString(resource, field);
          if (value) attributes[attr] = tf.str(value);
        }
        return { resource: { type: "okta_user", name: login, attributes, importId } };
      }
      case "group": {
        if (fieldString(resource, "type") !== "OKTA_GROUP") return null;
        const name = fieldString(resource, "name");
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return { resource: { type: "okta_group", name, attributes, importId } };
      }
      case "authorization-server": {
        const name = fieldString(resource, "name");
        const audiences = fieldString(resource, "audiences");
        if (!name || !audiences) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          audiences: csv(audiences),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return { resource: { type: "okta_auth_server", name, attributes, importId } };
      }
      case "network-zone": {
        if (fieldString(resource, "type") !== "IP") return null;
        const name = fieldString(resource, "name");
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          type: tf.str("IP"),
          usage: tf.str(fieldString(resource, "usage") || "POLICY"),
        };
        const gateways = fieldString(resource, "gateways");
        if (gateways) attributes["gateways"] = csv(gateways);
        const proxies = fieldString(resource, "proxies");
        if (proxies) attributes["proxies"] = csv(proxies);
        return { resource: { type: "okta_network_zone", name, attributes, importId } };
      }
      case "event-hook": {
        const name = fieldString(resource, "name");
        const uri = fieldString(resource, "uri");
        const events = fieldString(resource, "events");
        if (!name || !uri || !events) return null;
        return {
          resource: {
            type: "okta_event_hook",
            name,
            attributes: {
              name: tf.str(name),
              events: csv(events),
              channel: tf.map({ type: tf.str("HTTP"), version: tf.str("1.0.0"), uri: tf.str(uri) }),
            },
            importId,
            comments: [
              "Okta never returns the auth header value; add an `auth` block if the endpoint needs one.",
            ],
          },
        };
      }
      case "domain": {
        const name = fieldString(resource, "domain");
        if (!name) return null;
        return {
          resource: {
            type: "okta_domain",
            name,
            attributes: {
              name: tf.str(name),
              certificate_source_type: tf.str(
                fieldString(resource, "certificateSourceType") || "MANUAL",
              ),
            },
            importId,
          },
        };
      }
      default:
        return null;
    }
  },
};
