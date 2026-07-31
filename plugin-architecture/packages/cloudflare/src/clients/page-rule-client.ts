import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone, resolveZoneName } from "./shared.js";
import type {
  PageRuleCreateParams,
  PageRuleUpdateParams,
} from "cloudflare/resources/page-rules/page-rules";

/**
 * Page rule statuses the API accepts (`PageRuleCreateParams.status`). The
 * `status` resource field is free text, so anything else falls back to the
 * default below rather than being forwarded.
 */
const PAGE_RULE_STATUSES = ["active", "disabled"] as const satisfies readonly NonNullable<
  PageRuleCreateParams["status"]
>[];
type PageRuleStatus = (typeof PAGE_RULE_STATUSES)[number];

const DEFAULT_PAGE_RULE_STATUS: PageRuleStatus = "active";

function isPageRuleStatus(value: string): value is PageRuleStatus {
  return (PAGE_RULE_STATUSES as readonly string[]).includes(value);
}

function mapPageRule(
  rule: Record<string, unknown>,
  accountId: string,
  zoneId: string,
  zoneName: string,
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
      zoneName,
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
    async (zoneId, zoneName) => {
      const part: ResourceInstance[] = [];
      const rules = await api.cf.pageRules.list({ zone_id: zoneId });
      for (const rule of rules) {
        part.push(mapPageRule(asRecord(rule), accountId, zoneId, zoneName));
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
  // `targets` has one concrete shape and is checked against the SDK type.
  const targets: PageRuleCreateParams["targets"] = [
    {
      target: "url",
      constraint: { operator: "matches", value: fields["urlPattern"] ?? "" },
    },
  ];
  // `actions`, by contrast, is a 34-member discriminated union keyed on a
  // string-literal `id` (PageRuleCreateParams.actions, page-rules.d.ts:504),
  // where each variant carries its own `value` type — an object for
  // `forwarding_url`, a number for `browser_cache_ttl`, per-action string
  // unions elsewhere, and no `value` at all for `always_use_https`. The create
  // form hands us an opaque `id` + `value` string pair, so satisfying the union
  // would need a switch over every action Cloudflare supports. The cast below
  // covers that one unmodelled field.
  const body: Record<string, unknown> = {
    zone_id: zoneId,
    targets,
    actions: [
      {
        id: fields["action"] ?? "",
        ...(fields["actionValue"] ? { value: fields["actionValue"] } : {}),
      },
    ],
    status: DEFAULT_PAGE_RULE_STATUS,
  };
  const rule = await api.cf.pageRules.create(body as unknown as PageRuleCreateParams);
  return mapPageRule(asRecord(rule), accountId, zoneId, await resolveZoneName(api, zoneId));
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
  const current = asRecord(
    await api.cf.pageRules.get(ruleId, {
      zone_id: zoneId,
    }),
  );
  const status = fields["status"] || String(current["status"] ?? DEFAULT_PAGE_RULE_STATUS);
  const priority = fields["priority"];
  // `targets` and `actions` are round-tripped verbatim from `get`, so they are
  // `unknown` here, and `actions` is in any case the 34-member discriminated
  // union described in `createPageRule` (PageRuleUpdateParams.actions,
  // page-rules.d.ts:827) that an opaque round-trip cannot satisfy. Everything
  // else in the body is narrowed above and checked by the SDK types.
  const body: Record<string, unknown> = {
    zone_id: zoneId,
    targets: current["targets"] ?? [],
    actions: current["actions"] ?? [],
    status: isPageRuleStatus(status) ? status : DEFAULT_PAGE_RULE_STATUS,
    ...(priority && Number.isFinite(Number(priority)) ? { priority: Number(priority) } : {}),
  };
  const rule = await api.cf.pageRules.update(ruleId, body as unknown as PageRuleUpdateParams);
  return mapPageRule(asRecord(rule), accountId, zoneId, await resolveZoneName(api, zoneId));
}

export async function deletePageRule(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, ruleId] = externalId.split("/");
  if (!zoneId || !ruleId) throw new Error("Invalid page rule ID");
  await api.cf.pageRules.delete(ruleId, { zone_id: zoneId });
}
