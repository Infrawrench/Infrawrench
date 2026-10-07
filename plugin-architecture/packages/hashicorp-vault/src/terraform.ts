import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for the official `hashicorp/vault` provider (5.x,
 * registry docs read 2026-10): `vault_mount` and `vault_auth_backend` (import
 * by path), `vault_policy` (by name; the HCL comes from the cached `policy`
 * output), `vault_audit` (by path) and `vault_pki_secret_backend_role`
 * (import `<mount>/roles/<name>`). KV secret values are never exported:
 * Terraform would write them into state in plain text.
 */
const list = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const vaultTerraformExport: TerraformExportCapability = {
  provider: { name: "vault", source: "hashicorp/vault", version: "~> 5.12" },
  providerConfig: { address: tf.ref("var.vault_address"), token: tf.ref("var.vault_token") },
  variables: [
    { name: "vault_address", description: "Vault address, e.g. https://vault.example.com:8200" },
    {
      name: "vault_token",
      description: "Vault token with rights over the exported objects",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "vault-mount",
    "vault-auth-method",
    "vault-policy",
    "vault-audit-device",
    "vault-pki-role",
  ],
  mapResource(resource): TerraformExportResult | null {
    const s = (k: string) => fieldString(resource, k);
    switch (resource.resourceTypeId) {
      case "vault-mount": {
        const path = s("path");
        const type = s("type");
        if (
          !path ||
          !type ||
          ["cubbyhole", "identity", "system", "ns_system", "ns_identity", "ns_cubbyhole"].includes(
            type,
          )
        )
          return null;
        const attributes: Record<string, TerraformValue> = {
          path: tf.str(path),
          type: tf.str(type === "kv-v2" ? "kv" : type),
        };
        if (type === "kv-v2") attributes["options"] = tf.map({ version: tf.str("2") });
        if (s("description")) attributes["description"] = tf.str(s("description"));
        const dt = fieldNumber(resource, "defaultLeaseTtl");
        if (dt) attributes["default_lease_ttl_seconds"] = tf.num(dt);
        const mt = fieldNumber(resource, "maxLeaseTtl");
        if (mt) attributes["max_lease_ttl_seconds"] = tf.num(mt);
        if (fieldBool(resource, "local")) attributes["local"] = tf.bool(true);
        return { resource: { type: "vault_mount", name: path, attributes, importId: path } };
      }
      case "vault-auth-method": {
        const path = s("path");
        const type = s("type");
        if (!path || !type || type === "token") return null;
        const attributes: Record<string, TerraformValue> = {
          type: tf.str(type),
          path: tf.str(path),
        };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        if (fieldBool(resource, "local")) attributes["local"] = tf.bool(true);
        return { resource: { type: "vault_auth_backend", name: path, attributes, importId: path } };
      }
      case "vault-policy": {
        const name = s("name");
        const policy = resource.resolvedOutputs["policy"];
        if (!name || name === "root" || !policy) return null;
        return {
          resource: {
            type: "vault_policy",
            name,
            attributes: { name: tf.str(name), policy: tf.str(policy) },
            importId: name,
          },
        };
      }
      case "vault-audit-device": {
        const path = s("path");
        const type = s("type");
        if (!path || !type) return null;
        const options: Record<string, TerraformValue> = {};
        for (const pair of list(s("options"))) {
          const i = pair.indexOf("=");
          if (i > 0) options[pair.slice(0, i)] = tf.str(pair.slice(i + 1));
        }
        const attributes: Record<string, TerraformValue> = {
          type: tf.str(type),
          path: tf.str(path),
          options: tf.map(options),
        };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        return { resource: { type: "vault_audit", name: path, attributes, importId: path } };
      }
      case "vault-pki-role": {
        const mount = s("mount");
        const name = s("name");
        if (!mount || !name) return null;
        const attributes: Record<string, TerraformValue> = {
          backend: tf.str(mount),
          name: tf.str(name),
        };
        const domains = list(s("allowedDomains"));
        if (domains.length) attributes["allowed_domains"] = tf.list(domains.map(tf.str));
        const flags: Record<string, string> = {
          allowSubdomains: "allow_subdomains",
          allowBareDomains: "allow_bare_domains",
          allowGlobDomains: "allow_glob_domains",
          allowAnyName: "allow_any_name",
          allowIpSans: "allow_ip_sans",
          allowLocalhost: "allow_localhost",
          enforceHostnames: "enforce_hostnames",
          serverFlag: "server_flag",
          clientFlag: "client_flag",
        };
        for (const [field, attr] of Object.entries(flags)) {
          if (resource.fields[field] !== undefined)
            attributes[attr] = tf.bool(fieldBool(resource, field));
        }
        const ttl = fieldNumber(resource, "ttl");
        if (ttl) attributes["ttl"] = tf.str(String(ttl));
        const maxTtl = fieldNumber(resource, "maxTtl");
        if (maxTtl) attributes["max_ttl"] = tf.str(String(maxTtl));
        if (s("keyType")) attributes["key_type"] = tf.str(s("keyType"));
        const bits = fieldNumber(resource, "keyBits");
        if (bits) attributes["key_bits"] = tf.num(bits);
        return {
          resource: {
            type: "vault_pki_secret_backend_role",
            name: `${mount}_${name}`,
            attributes,
            importId: `${mount}/roles/${name}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
