import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import type { EdgeRule } from "./types.js";
import { EDGE_ACTIONS, MATCH_TYPES, TRIGGER_TYPES, enumName } from "./types.js";
import { splitChild, splitList } from "./mappers.js";

/**
 * Terraform mapping for the official `BunnyWay/bunnynet` provider (0.19.1,
 * 2026-09-24; schemas from docs/resources/*.md). Import ids are the
 * provider's: numeric ids for zones and libraries, `pullzone|hostname`,
 * `pullzone|guid` and `zone|record`. Edge scripts are not mapped: the
 * resource needs the script's code, which inventory does not hold, and
 * Magic Containers apps need their full container templates.
 */
export const bunnyTerraformExport: TerraformExportCapability = {
  provider: { name: "bunnynet", source: "BunnyWay/bunnynet", version: "~> 0.19" },
  providerConfig: { api_key: tf.ref("var.bunnynet_api_key") },
  variables: [
    { name: "bunnynet_api_key", description: "bunny.net account API key", sensitive: true },
  ],
  supportedResourceTypeIds: [
    "pull-zone",
    "hostname",
    "edge-rule",
    "storage-zone",
    "dns-zone",
    "dns-record",
    "video-library",
  ],
  mapResource(r): TerraformExportResult | null {
    const id = r.externalId ?? "";
    switch (r.resourceTypeId) {
      case "pull-zone": {
        const name = fieldString(r, "name");
        if (!name) return null;
        let origin: {
          type?: string;
          url?: string;
          storageZoneId?: number;
          edgeScriptId?: number;
          containerAppId?: string;
        } = {};
        try {
          origin = JSON.parse(fieldString(r, "originJson") || "{}") as typeof origin;
        } catch {
          origin = {};
        }
        const block: Record<string, TerraformValue> = {};
        switch (origin.type) {
          case "Storage":
            block["type"] = tf.str("StorageZone");
            if (origin.storageZoneId) block["storagezone"] = tf.num(origin.storageZoneId);
            break;
          case "EdgeScript":
            block["type"] = tf.str("ComputeScript");
            if (origin.edgeScriptId) block["script"] = tf.num(origin.edgeScriptId);
            break;
          case "MagicContainer":
            block["type"] = tf.str("ComputeContainer");
            if (origin.containerAppId) block["container_app_id"] = tf.str(origin.containerAppId);
            break;
          default:
            block["type"] = tf.str("OriginUrl");
            if (origin.url) block["url"] = tf.str(origin.url);
        }
        return {
          resource: {
            type: "bunnynet_pullzone",
            name,
            attributes: { name: tf.str(name), origin: tf.block(block) },
            importId: id,
          },
        };
      }
      case "hostname": {
        if (fieldBool(r, "isSystem")) return null;
        const pz = fieldNumber(r, "pullZoneId");
        const host = fieldString(r, "hostname");
        if (!pz || !host) return null;
        return {
          resource: {
            type: "bunnynet_pullzone_hostname",
            name: host,
            attributes: {
              pullzone: tf.num(pz),
              name: tf.str(host),
              tls_enabled: tf.bool(fieldBool(r, "hasCertificate")),
              force_ssl: tf.bool(fieldBool(r, "forceSsl")),
            },
            importId: `${pz}|${host}`,
          },
        };
      }
      case "edge-rule": {
        const pz = fieldNumber(r, "pullZoneId");
        let rule: EdgeRule | undefined;
        try {
          rule = JSON.parse(fieldString(r, "ruleJson") || "null") as EdgeRule | undefined;
        } catch {
          rule = undefined;
        }
        if (!pz || !rule) return null;
        const attributes: Record<string, TerraformValue> = {
          pullzone: tf.num(pz),
          enabled: tf.bool(rule.Enabled !== false),
          action: tf.str(enumName(EDGE_ACTIONS, rule.ActionType)),
          match_type: tf.str(enumName(MATCH_TYPES, rule.TriggerMatchingType ?? 0)),
          triggers: tf.list(
            (rule.Triggers ?? []).map((t) =>
              tf.map({
                type: tf.str(enumName(TRIGGER_TYPES, t.Type)),
                match_type: tf.str(enumName(MATCH_TYPES, t.PatternMatchingType ?? 0)),
                patterns: tf.list((t.PatternMatches ?? []).map(tf.str)),
                parameter1: t.Parameter1 ? tf.str(t.Parameter1) : tf.ref("null"),
                parameter2: tf.ref("null"),
              }),
            ),
          ),
        };
        if (rule.Description) attributes["description"] = tf.str(rule.Description);
        if (rule.ActionParameter1) attributes["action_parameter1"] = tf.str(rule.ActionParameter1);
        if (rule.ActionParameter2) attributes["action_parameter2"] = tf.str(rule.ActionParameter2);
        if (rule.ActionParameter3) attributes["action_parameter3"] = tf.str(rule.ActionParameter3);
        return {
          resource: {
            type: "bunnynet_pullzone_edgerule",
            name: rule.Description || `edge rule ${rule.Guid.slice(0, 8)}`,
            attributes,
            importId: `${pz}|${rule.Guid}`,
          },
        };
      }
      case "storage-zone": {
        const name = fieldString(r, "name");
        const region = fieldString(r, "region");
        if (!name || !region) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          region: tf.str(region),
          zone_tier: tf.str(fieldString(r, "tier") || "Standard"),
        };
        const repl = splitList(fieldString(r, "replicationRegions"));
        if (repl.length > 0) attributes["replication_regions"] = tf.list(repl.map(tf.str));
        return { resource: { type: "bunnynet_storage_zone", name, attributes, importId: id } };
      }
      case "dns-zone": {
        const domain = fieldString(r, "name");
        if (!domain) return null;
        return {
          resource: {
            type: "bunnynet_dns_zone",
            name: domain,
            attributes: { domain: tf.str(domain) },
            importId: id,
          },
        };
      }
      case "dns-record": {
        const { parent: zone, key } = splitChild(id);
        const type = fieldString(r, "type");
        if (!zone || !type) return null;
        const attributes: Record<string, TerraformValue> = {
          zone: tf.num(Number(zone)),
          name: tf.str(fieldString(r, "name")),
          type: tf.str(type),
          value: tf.str(fieldString(r, "content")),
        };
        for (const k of ["ttl", "priority", "weight", "port"] as const) {
          const v = fieldNumber(r, k);
          if (v) attributes[k] = tf.num(v);
        }
        return {
          resource: {
            type: "bunnynet_dns_record",
            name: `${type} ${fieldString(r, "name") || "apex"}`,
            attributes,
            importId: `${zone}|${key}`,
          },
        };
      }
      case "video-library": {
        const name = fieldString(r, "name");
        if (!name) return null;
        return {
          resource: {
            type: "bunnynet_stream_library",
            name,
            attributes: { name: tf.str(name) },
            importId: id,
          },
        };
      }
      default:
        return null;
    }
  },
};
