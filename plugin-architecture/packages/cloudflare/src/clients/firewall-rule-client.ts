import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { collectPerZone } from "./shared.js";
import type { RulesetCreateParams } from "cloudflare/resources/rulesets/rulesets";
import type { RuleCreateParams } from "cloudflare/resources/rulesets/rules";

function mapFirewallRule(
  rule: Record<string, unknown>,
  accountId: string,
  zoneId: string,
  rulesetId?: string,
): ResourceInstance {
  const id = String(rule["id"] ?? "");
  const description = String(rule["description"] ?? "");
  const externalIdSuffix = rulesetId ? `${zoneId}/${rulesetId}/${id}` : `${zoneId}/${id}`;
  return {
    id: `${accountId}:firewall-rule:${externalIdSuffix}`,
    pluginId: "cloudflare",
    resourceTypeId: "firewall-rule",
    accountId,
    displayName: description || `Rule ${id.slice(0, 8)}`,
    fields: {
      description,
      expression: String(rule["expression"] ?? ""),
      action: String(rule["action"] ?? ""),
      enabled: Boolean(rule["enabled"] ?? true),
      ...(rule["priority"] !== undefined ? { priority: Number(rule["priority"]) } : {}),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: externalIdSuffix,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function findCustomRuleset(
  api: CloudflareApi,
  zoneId: string,
): Promise<Record<string, unknown> | null> {
  for await (const rs of api.cf.rulesets.list({ zone_id: zoneId })) {
    const raw = rs as unknown as Record<string, unknown>;
    if (raw["phase"] === "http_request_firewall_custom") return raw;
  }
  return null;
}

export async function listAllFirewallRules(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      const customRuleset = await findCustomRuleset(api, zoneId);
      if (customRuleset) {
        const rsId = String(customRuleset["id"]);
        const fullRuleset = await api.cf.rulesets.get(rsId, { zone_id: zoneId });
        const full = fullRuleset as unknown as Record<string, unknown>;
        const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
        for (const rule of rules) {
          part.push(mapFirewallRule(rule, accountId, zoneId, rsId));
        }
      }
      return part;
    },
    "firewall rules",
    "Zone · Zone WAF:Read",
  );
}

export async function createFirewallRule(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a firewall rule");

  // Find an existing http_request_firewall_custom ruleset to attach to.
  let rulesetId = "";
  try {
    const existing = await findCustomRuleset(api, zoneId);
    if (existing) rulesetId = String(existing["id"] ?? "");
  } catch {
    // Ignore — we'll create via the phase entrypoint below.
  }

  const ruleBody: Record<string, unknown> = {
    description: fields["description"] ?? "",
    expression: fields["expression"] ?? "",
    action: fields["action"] ?? "",
    enabled: true,
  };

  let result: Record<string, unknown>;
  if (rulesetId) {
    const ruleset = await api.cf.rulesets.rules.create(rulesetId, {
      zone_id: zoneId,
      ...ruleBody,
    } as unknown as RuleCreateParams);
    const full = ruleset as unknown as Record<string, unknown>;
    const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
    result = rules[rules.length - 1] ?? full;
  } else {
    const ruleset = await api.cf.rulesets.create({
      zone_id: zoneId,
      name: "Custom Firewall Rules",
      kind: "zone",
      phase: "http_request_firewall_custom",
      rules: [ruleBody],
    } as unknown as RulesetCreateParams);
    const full = ruleset as unknown as Record<string, unknown>;
    rulesetId = String(full["id"] ?? "");
    const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
    result = rules[0] ?? full;
  }
  return mapFirewallRule(result, accountId, zoneId, rulesetId);
}

export async function deleteFirewallRule(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, rulesetId, ruleId] = externalId.split("/");
  if (!zoneId || !rulesetId || !ruleId) throw new Error("Invalid firewall rule ID");
  await api.cf.rulesets.rules.delete(rulesetId, ruleId, { zone_id: zoneId });
}
