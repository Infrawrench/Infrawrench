import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { collectPerZone } from "./shared.js";
import type { PageRuleCreateParams } from "cloudflare/resources/page-rules/page-rules";

function mapPageRule(
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
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      const rules = await api.cf.pageRules.list({ zone_id: zoneId });
      for (const rule of rules) {
        part.push(mapPageRule(rule as unknown as Record<string, unknown>, accountId, zoneId));
      }
      return part;
    },
    "page rules",
    "Zone · Page Rules:Read",
  );
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
    zone_id: zoneId,
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
  const rule = await api.cf.pageRules.create(body as unknown as PageRuleCreateParams);
  return mapPageRule(rule as unknown as Record<string, unknown>, accountId, zoneId);
}

export async function editPageRule(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, ruleId] = externalId.split("/");
  if (!zoneId || !ruleId) throw new Error("Invalid page rule ID");
  // targets/actions are flattened to display strings on read, so preserve them
  // from the live rule and only edit the toggleable status + priority.
  const current = (await api.cf.pageRules.get(ruleId, {
    zone_id: zoneId,
  })) as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = {
    zone_id: zoneId,
    targets: current["targets"] ?? [],
    actions: current["actions"] ?? [],
    status: fields["status"] || String(current["status"] ?? "active"),
    ...(fields["priority"] && Number.isFinite(Number(fields["priority"]))
      ? { priority: Number(fields["priority"]) }
      : {}),
  };
  const rule = await api.cf.pageRules.update(
    ruleId,
    body as unknown as Parameters<typeof api.cf.pageRules.update>[1],
  );
  return mapPageRule(rule as unknown as Record<string, unknown>, accountId, zoneId);
}

export async function deletePageRule(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, ruleId] = externalId.split("/");
  if (!zoneId || !ruleId) throw new Error("Invalid page rule ID");
  await api.cf.pageRules.delete(ruleId, { zone_id: zoneId });
}
