import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapPageRule(
  rule: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(rule["id"] ?? "");
  const targets = Array.isArray(rule["targets"])
    ? (rule["targets"] as Array<Record<string, unknown>>)
        .map((t) => {
          const constraint = t["constraint"] as Record<string, unknown> | undefined;
          return String(constraint?.["value"] ?? "");
        })
        .join(", ")
    : "";
  const actions = Array.isArray(rule["actions"])
    ? (rule["actions"] as Array<Record<string, unknown>>)
        .map((a) => String(a["id"] ?? ""))
        .join(", ")
    : "";
  return {
    id: `${accountId}:page-rule:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "page-rule",
    accountId,
    displayName: targets || `Rule ${id.slice(0, 8)}`,
    fields: {
      targets,
      actions,
      status: String(rule["status"] ?? ""),
      priority: Number(rule["priority"] ?? 0),
      createdOn: String(rule["created_on"] ?? ""),
      modifiedOn: String(rule["modified_on"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: String(rule["created_on"] ?? new Date().toISOString()),
    updatedAt: String(rule["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listAllPageRules(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    try {
      const rules = await api.paginate<Record<string, unknown>>(`/zones/${zoneId}/pagerules`);
      for (const rule of rules) {
        results.push(mapPageRule(rule, accountId, zoneId));
      }
    } catch {
      // Skip zones where we can't read page rules
    }
  }
  return results;
}

export async function createPageRule(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a page rule");
  const body: Record<string, unknown> = {
    targets: [
      {
        target: "url",
        constraint: { operator: "matches", value: fields["urlPattern"] ?? "" },
      },
    ],
    actions: [
      {
        id: fields["action"] ?? "",
        ...(fields["actionValue"] ? { value: fields["actionValue"] } : {}),
      },
    ],
    status: "active",
  };
  const rule = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/pagerules`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return mapPageRule(rule, accountId, zoneId);
}

export async function deletePageRule(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, ruleId] = externalId.split("/");
  if (!zoneId || !ruleId) throw new Error("Invalid page rule ID");
  await api.fetch(`/zones/${zoneId}/pagerules/${ruleId}`, { method: "DELETE" });
}
