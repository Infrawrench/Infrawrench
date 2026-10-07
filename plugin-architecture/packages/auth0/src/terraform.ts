import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Auth0: the official `auth0/auth0` provider (1.x,
 * attributes checked against registry.terraform.io 2026-10). Import ids are
 * the Auth0 ids (client_id for clients).
 *   - auth0_client: name, app_type, description, callbacks, allowed_logout_urls, web_origins, allowed_origins.
 *   - auth0_resource_server: identifier, name, signing_alg, token_lifetime, allow_offline_access,
 *     skip_consent_for_verifiable_first_party_clients, enforce_policies.
 *   - auth0_role: name, description.
 *   - auth0_organization: name, display_name.
 *   - auth0_action: name, runtime, supported_triggers block, code from a variable (not stored in inventory).
 *   - auth0_custom_domain: domain, type.
 *   - auth0_tenant: friendly_name, support_email, support_url, session lifetimes, enabled_locales
 *     (import id is any UUID; the tenant is a singleton).
 * Connections (strategy-specific `options` with secrets), users and log
 * streams (sink credentials) are not exported.
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

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "auth0"
  );
}

export const auth0TerraformExport: TerraformExportCapability = {
  provider: { name: "auth0", source: "auth0/auth0", version: "~> 1.0" },
  providerConfig: {
    domain: tf.ref("var.auth0_domain"),
    client_id: tf.ref("var.auth0_client_id"),
    client_secret: tf.ref("var.auth0_client_secret"),
  },
  variables: [
    { name: "auth0_domain", description: "Auth0 tenant domain, e.g. acme.us.auth0.com" },
    { name: "auth0_client_id", description: "Management API M2M client ID", sensitive: true },
    {
      name: "auth0_client_secret",
      description: "Management API M2M client secret",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "tenant",
    "application",
    "api",
    "role",
    "organization",
    "action",
    "custom-domain",
  ],
  mapResource(resource): TerraformExportResult | null {
    const importId = resource.externalId;
    switch (resource.resourceTypeId) {
      case "tenant": {
        const attributes: Record<string, TerraformValue> = {};
        for (const [field, attr] of [
          ["friendlyName", "friendly_name"],
          ["supportEmail", "support_email"],
          ["supportUrl", "support_url"],
          ["pictureUrl", "picture_url"],
          ["defaultAudience", "default_audience"],
          ["defaultDirectory", "default_directory"],
        ] as const) {
          const value = fieldString(resource, field);
          if (value) attributes[attr] = tf.str(value);
        }
        const session = fieldNumber(resource, "sessionLifetime");
        if (session !== undefined) attributes["session_lifetime"] = tf.num(session);
        const idle = fieldNumber(resource, "idleSessionLifetime");
        if (idle !== undefined) attributes["idle_session_lifetime"] = tf.num(idle);
        const locales = fieldString(resource, "enabledLocales");
        if (locales) attributes["enabled_locales"] = csv(locales);
        return {
          resource: {
            type: "auth0_tenant",
            name: "tenant",
            attributes,
            comments: [
              "auth0_tenant is a singleton: import it with any UUID, e.g. `terraform import auth0_tenant.tenant 82f4f21b-017a-319d-92e7-2291c1ca36c4`.",
            ],
          },
        };
      }
      case "application": {
        const name = fieldString(resource, "name");
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const appType = fieldString(resource, "appType");
        if (appType) attributes["app_type"] = tf.str(appType);
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        for (const [field, attr] of [
          ["callbacks", "callbacks"],
          ["allowedLogoutUrls", "allowed_logout_urls"],
          ["webOrigins", "web_origins"],
          ["allowedOrigins", "allowed_origins"],
        ] as const) {
          const value = fieldString(resource, field);
          if (value) attributes[attr] = csv(value);
        }
        return { resource: { type: "auth0_client", name: slug(name), attributes, importId } };
      }
      case "api": {
        if (fieldBool(resource, "isSystem")) return null;
        const identifier = fieldString(resource, "identifier");
        if (!identifier) return null;
        const attributes: Record<string, TerraformValue> = { identifier: tf.str(identifier) };
        const name = fieldString(resource, "name");
        if (name) attributes["name"] = tf.str(name);
        const alg = fieldString(resource, "signingAlg");
        if (alg) attributes["signing_alg"] = tf.str(alg);
        const lifetime = fieldNumber(resource, "tokenLifetime");
        if (lifetime !== undefined) attributes["token_lifetime"] = tf.num(lifetime);
        attributes["allow_offline_access"] = tf.bool(fieldBool(resource, "allowOfflineAccess"));
        attributes["skip_consent_for_verifiable_first_party_clients"] = tf.bool(
          fieldBool(resource, "skipConsent"),
        );
        attributes["enforce_policies"] = tf.bool(fieldBool(resource, "enforcePolicies"));
        return {
          resource: {
            type: "auth0_resource_server",
            name: slug(name || identifier),
            attributes,
            importId,
          },
        };
      }
      case "role": {
        const name = fieldString(resource, "name");
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return { resource: { type: "auth0_role", name: slug(name), attributes, importId } };
      }
      case "organization": {
        const name = fieldString(resource, "name");
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const display = fieldString(resource, "displayName");
        if (display) attributes["display_name"] = tf.str(display);
        return { resource: { type: "auth0_organization", name: slug(name), attributes, importId } };
      }
      case "action": {
        const name = fieldString(resource, "name");
        const trigger = fieldString(resource, "trigger");
        if (!name || !trigger) return null;
        const [id, version] = trigger.split("@");
        const variable = `auth0_action_${slug(name)}_code`;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          code: tf.ref(`var.${variable}`),
          supported_triggers: tf.block({ id: tf.str(id ?? ""), version: tf.str(version ?? "") }),
        };
        const runtime = fieldString(resource, "runtime");
        if (runtime) attributes["runtime"] = tf.str(runtime);
        return {
          resource: {
            type: "auth0_action",
            name: slug(name),
            attributes,
            importId,
            comments: [
              `Set var.${variable} to the action's source (copy it from the action's detail page).`,
            ],
          },
          variables: [{ name: variable, description: `Source code of Auth0 action ${name}` }],
        };
      }
      case "custom-domain": {
        const domain = fieldString(resource, "domain");
        if (!domain) return null;
        return {
          resource: {
            type: "auth0_custom_domain",
            name: slug(domain),
            attributes: {
              domain: tf.str(domain),
              type: tf.str(fieldString(resource, "type") || "auth0_managed_certs"),
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
