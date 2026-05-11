import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapFirewallRule(
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

export async function listAllFirewallRules(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    try {
      // Use the WAF custom rules endpoint (rulesets)
      const rulesets = await api.fetch<{ rulesets?: Array<Record<string, unknown>> }>(
        `/zones/${zoneId}/rulesets`,
      );
      const customRuleset = ((rulesets as unknown as Array<Record<string, unknown>>) ?? []).find(
        (rs: Record<string, unknown>) => rs["phase"] === "http_request_firewall_custom",
      );
      if (customRuleset) {
        const rsId = String(customRuleset["id"]);
        const fullRuleset = await api.fetch<Record<string, unknown>>(
          `/zones/${zoneId}/rulesets/${rsId}`,
        );
        const rules = (fullRuleset["rules"] as Array<Record<string, unknown>>) ?? [];
        for (const rule of rules) {
          results.push(mapFirewallRule(rule, accountId, zoneId, rsId));
        }
      }
    } catch {
      // Skip zones where we can't read firewall rules
    }
  }
  return results;
}

export async function createFirewallRule(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a firewall rule");
  // Get or create the http_request_firewall_custom phase ruleset
  let rulesetId = "";
  try {
    const rulesets = await api.fetch<Array<Record<string, unknown>>>(`/zones/${zoneId}/rulesets`);
    const customRuleset = (rulesets ?? []).find(
      (rs: Record<string, unknown>) => rs["phase"] === "http_request_firewall_custom",
    );
    if (customRuleset) {
      rulesetId = String(customRuleset["id"]);
    }
  } catch {
    // Ignore - we'll create via the phase entrypoint
  }
  const ruleBody = {
    description: fields["description"] ?? "",
    expression: fields["expression"] ?? "",
    action: fields["action"] ?? "",
    enabled: true,
  };
  let result: Record<string, unknown>;
  if (rulesetId) {
    const ruleset = await api.fetch<Record<string, unknown>>(
      `/zones/${zoneId}/rulesets/${rulesetId}/rules`,
      {
        method: "POST",
        body: JSON.stringify(ruleBody),
      },
    );
    const rules = (ruleset["rules"] as Array<Record<string, unknown>>) ?? [];
    result = rules[rules.length - 1] ?? ruleset;
  } else {
    const ruleset = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/rulesets`, {
      method: "POST",
      body: JSON.stringify({
        name: "Custom Firewall Rules",
        kind: "zone",
        phase: "http_request_firewall_custom",
        rules: [ruleBody],
      }),
    });
    rulesetId = String(ruleset["id"] ?? "");
    const rules = (ruleset["rules"] as Array<Record<string, unknown>>) ?? [];
    result = rules[0] ?? ruleset;
  }
  return mapFirewallRule(result, accountId, zoneId, rulesetId);
}

export async function deleteFirewallRule(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, rulesetId, ruleId] = externalId.split("/");
  if (!zoneId || !rulesetId || !ruleId) throw new Error("Invalid firewall rule ID");
  await api.fetch(`/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, {
    method: "DELETE",
  });
}
