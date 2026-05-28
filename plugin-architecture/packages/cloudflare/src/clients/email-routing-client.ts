import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { collectPerZone } from "./shared.js";
import type { RuleCreateParams } from "cloudflare/resources/email-routing/rules/rules";

function mapEmailRoutingRule(
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
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      for await (const rule of api.cf.emailRouting.rules.list({ zone_id: zoneId })) {
        part.push(
          mapEmailRoutingRule(rule as unknown as Record<string, unknown>, accountId, zoneId),
        );
      }
      return part;
    },
    "email routing rules",
    "Zone · Email Routing Rules:Read",
  );
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
    zone_id: zoneId,
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
  const rule = await api.cf.emailRouting.rules.create(body as unknown as RuleCreateParams);
  return mapEmailRoutingRule(rule as unknown as Record<string, unknown>, accountId, zoneId);
}
