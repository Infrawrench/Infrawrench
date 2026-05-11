import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapEmailRoutingRule(
  rule: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const tag = String(rule["tag"] ?? rule["id"] ?? "");
  const name = String(rule["name"] ?? "");
  const matchers = Array.isArray(rule["matchers"])
    ? (rule["matchers"] as Array<Record<string, unknown>>)
        .map(
          (m) =>
            `${String(m["type"] ?? "")}:${String(m["field"] ?? "")}=${String(m["value"] ?? "")}`,
        )
        .join(", ")
    : "";
  const actions = Array.isArray(rule["actions"])
    ? (rule["actions"] as Array<Record<string, unknown>>)
        .map((a) => {
          const vals = Array.isArray(a["value"])
            ? (a["value"] as string[]).join(", ")
            : String(a["value"] ?? "");
          return `${String(a["type"] ?? "")}: ${vals}`;
        })
        .join("; ")
    : "";
  return {
    id: `${accountId}:email-routing-rule:${zoneId}/${tag}`,
    pluginId: "cloudflare",
    resourceTypeId: "email-routing-rule",
    accountId,
    displayName: name || `Rule ${tag.slice(0, 8)}`,
    fields: {
      name,
      enabled: Boolean(rule["enabled"] ?? true),
      matchers,
      actions,
      priority: Number(rule["priority"] ?? 0),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${tag}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listAllEmailRoutingRules(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    try {
      const rules = await api.paginate<Record<string, unknown>>(
        `/zones/${zoneId}/email/routing/rules`,
      );
      for (const rule of rules) {
        results.push(mapEmailRoutingRule(rule, accountId, zoneId));
      }
    } catch {
      // Skip zones where email routing is not enabled
    }
  }
  return results;
}

export async function createEmailRoutingRule(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId)
    throw new Error("Cloudflare plugin: zoneId is required to create an email routing rule");
  const matcherField = fields["matcherField"] ?? "to";
  const matcherValue = fields["matcherValue"] ?? "";
  const actionType = fields["actionType"] ?? "forward";
  const actionValue = fields["actionValue"] ?? "";
  const body: Record<string, unknown> = {
    name: fields["name"] ?? "",
    enabled: true,
    matchers: [{ type: "literal", field: matcherField, value: matcherValue }],
    actions: [
      {
        type: actionType,
        ...(actionType !== "drop" && actionValue ? { value: [actionValue] } : {}),
      },
    ],
  };
  const rule = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/email/routing/rules`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return mapEmailRoutingRule(rule, accountId, zoneId);
}
