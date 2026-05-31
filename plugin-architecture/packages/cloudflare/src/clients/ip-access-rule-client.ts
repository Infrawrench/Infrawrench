import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { collectPerZone } from "./shared.js";

/**
 * Cloudflare IP Access Rules (`/zones/{id}/firewall/access_rules/rules`) — the
 * classic allow/block/challenge list keyed by IP, CIDR, ASN, or country. Each
 * rule's externalId is `<zoneId>/<ruleId>` so delete can address it directly.
 */
function mapIpAccessRule(
  rule: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(rule["id"] ?? "");
  const config = (rule["configuration"] as Record<string, unknown>) ?? {};
  const target = String(config["target"] ?? "");
  const value = String(config["value"] ?? "");
  const mode = String(rule["mode"] ?? "");
  const notes = String(rule["notes"] ?? "");
  return {
    id: `${accountId}:ip-access-rule:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "ip-access-rule",
    accountId,
    displayName: notes || `${mode} ${value}` || `Rule ${id.slice(0, 8)}`,
    fields: { mode, target, value, notes },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listAllIpAccessRules(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId) => {
      const out: ResourceInstance[] = [];
      for await (const rule of api.cf.firewall.accessRules.list({ zone_id: zoneId })) {
        out.push(mapIpAccessRule(rule as unknown as Record<string, unknown>, accountId, zoneId));
      }
      return out;
    },
    "IP access rules",
    "Zone · Firewall Services:Read",
  );
}

export async function createIpAccessRule(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create an IP access rule");

  const created = await api.cf.firewall.accessRules.create({
    zone_id: zoneId,
    mode: (fields["mode"] || "block") as
      | "block"
      | "challenge"
      | "whitelist"
      | "js_challenge"
      | "managed_challenge",
    configuration: {
      target: (fields["target"] || "ip") as "ip" | "ip_range" | "asn" | "country",
      value: fields["value"] ?? "",
    },
    ...(fields["notes"] ? { notes: fields["notes"] } : {}),
  } as Parameters<typeof api.cf.firewall.accessRules.create>[0]);

  return mapIpAccessRule(created as unknown as Record<string, unknown>, accountId, zoneId);
}

export async function editIpAccessRule(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, ruleId] = externalId.split("/");
  if (!zoneId || !ruleId) throw new Error("Invalid IP access rule ID");
  const updated = await api.cf.firewall.accessRules.edit(ruleId, {
    zone_id: zoneId,
    ...(fields["mode"]
      ? {
          mode: fields["mode"] as
            | "block"
            | "challenge"
            | "whitelist"
            | "js_challenge"
            | "managed_challenge",
        }
      : {}),
    ...(fields["notes"] !== undefined ? { notes: fields["notes"] } : {}),
  } as Parameters<typeof api.cf.firewall.accessRules.edit>[1]);
  return mapIpAccessRule(updated as unknown as Record<string, unknown>, accountId, zoneId);
}

export async function deleteIpAccessRule(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, ruleId] = externalId.split("/");
  if (!zoneId || !ruleId) throw new Error("Invalid IP access rule ID");
  await api.cf.firewall.accessRules.delete(ruleId, { zone_id: zoneId });
}
