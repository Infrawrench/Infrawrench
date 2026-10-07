import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";
import { parseMeta } from "./mappers.js";

/**
 * Terraform mapping for the official `hashicorp/consul` provider (2.23, docs
 * under docs/resources read 2026-10): `consul_acl_policy` (import by ID),
 * `consul_config_entry` (`config_json` from the stored entry, import
 * `<kind>/<name>`, or `<partition>/<namespace>/<kind>/<name>` outside the
 * defaults), `consul_namespace` and `consul_admin_partition` (import by name).
 * Intentions are config entries (`service-intentions`), so they export with
 * them. Tokens are not exported: an apply would mint a new secret.
 */
const BUILT_IN_POLICY = "00000000-0000-0000-0000-000000000001";

export const consulTerraformExport: TerraformExportCapability = {
  provider: { name: "consul", source: "hashicorp/consul", version: "~> 2.23" },
  providerConfig: { address: tf.ref("var.consul_address"), token: tf.ref("var.consul_token") },
  variables: [
    { name: "consul_address", description: "Consul HTTP address, e.g. consul.example.com:8500" },
    { name: "consul_token", description: "Consul ACL token", sensitive: true },
  ],
  supportedResourceTypeIds: [
    "consul-acl-policy",
    "consul-config-entry",
    "consul-namespace",
    "consul-partition",
  ],
  mapResource(resource): TerraformExportResult | null {
    const s = (k: string) => fieldString(resource, k);
    switch (resource.resourceTypeId) {
      case "consul-acl-policy": {
        const rules = resource.resolvedOutputs["rules"] ?? "";
        if (
          !s("name") ||
          !rules ||
          resource.externalId === BUILT_IN_POLICY ||
          s("builtIn") === "true"
        )
          return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(s("name")),
          rules: tf.str(rules),
        };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        const dcs = s("datacenters")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (dcs.length) attributes["datacenters"] = tf.list(dcs.map((d) => tf.str(d)));
        return {
          resource: {
            type: "consul_acl_policy",
            name: s("name"),
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "consul-config-entry": {
        const kind = s("kind");
        const name = s("name");
        const config = resource.resolvedOutputs["config"];
        if (!kind || !name || config === undefined) return null;
        const ns = s("namespace");
        const partition = s("partition");
        const scoped = (ns && ns !== "default") || (partition && partition !== "default");
        const attributes: Record<string, TerraformValue> = {
          kind: tf.str(kind),
          name: tf.str(name),
          config_json: tf.str(config),
        };
        if (ns && ns !== "default") attributes["namespace"] = tf.str(ns);
        if (partition && partition !== "default") attributes["partition"] = tf.str(partition);
        return {
          resource: {
            type: "consul_config_entry",
            name: `${kind}_${name}`,
            attributes,
            importId: scoped
              ? `${partition || "default"}/${ns || "default"}/${kind}/${name}`
              : `${kind}/${name}`,
          },
        };
      }
      case "consul-namespace": {
        const name = s("name");
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        const meta = parseMeta(s("meta"));
        if (Object.keys(meta).length)
          attributes["meta"] = tf.map(
            Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, tf.str(v)])),
          );
        return { resource: { type: "consul_namespace", name, attributes, importId: name } };
      }
      case "consul-partition": {
        const name = s("name");
        if (!name || name === "default") return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        return { resource: { type: "consul_admin_partition", name, attributes, importId: name } };
      }
      default:
        return null;
    }
  },
};
