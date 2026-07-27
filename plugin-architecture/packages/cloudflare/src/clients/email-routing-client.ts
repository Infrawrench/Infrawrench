import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone } from "./shared.js";
import type {
  ActionParam,
  MatcherParam,
  RuleCreateParams,
  RuleUpdateParams,
} from "cloudflare/resources/email-routing/rules/rules";

/**
 * The only actions Cloudflare Email Routing accepts on a rule
 * (`ActionParam["type"]`). Anything else falls back to `forward`, which is the
 * create form's default.
 */
const ACTION_TYPES = ["drop", "forward", "worker"] as const;

const isActionType = (value: string): value is ActionParam["type"] =>
  (ACTION_TYPES as readonly string[]).includes(value);

/**
 * Cloudflare only supports matching an email routing rule on its recipient —
 * `MatcherParam["field"]` is the single literal `"to"`. There is no sender-side
 * matcher, so reject anything else with a message the user can act on rather
 * than letting the API return an opaque 400.
 */
function toMatcherField(value: string | undefined): NonNullable<MatcherParam["field"]> {
  if (value === undefined || value === "" || value === "to") return "to";
  throw new Error(
    `Cloudflare plugin: email routing rules can only match on the recipient ("to"), not "${value}"`,
  );
}

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
        part.push(mapEmailRoutingRule(asRecord(rule), accountId, zoneId));
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
  const matcherField = toMatcherField(fields["matcherField"]);
  const matcherValue = fields["matcherValue"] ?? "";
  const rawActionType = fields["actionType"] ?? "forward";
  const actionType = isActionType(rawActionType) ? rawActionType : "forward";
  const actionValue = fields["actionValue"] ?? "";
  const body: RuleCreateParams = {
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
  const rule = await api.cf.emailRouting.rules.create(body);
  return mapEmailRoutingRule(asRecord(rule), accountId, zoneId);
}

export async function editEmailRoutingRule(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, tag] = externalId.split("/");
  if (!zoneId || !tag) throw new Error("Invalid email routing rule ID");
  // The update is a full replace, so preserve the current matchers/actions and
  // only override the editable name + enabled flag.
  const current = await api.cf.emailRouting.rules.get(tag, {
    zone_id: zoneId,
  });
  const body: RuleUpdateParams = {
    zone_id: zoneId,
    name: fields["name"] ?? current.name ?? "",
    enabled:
      fields["enabled"] !== undefined ? fields["enabled"] === "true" : Boolean(current.enabled),
    matchers: current.matchers ?? [],
    actions: current.actions ?? [],
  };
  const rule = await api.cf.emailRouting.rules.update(tag, body);
  return mapEmailRoutingRule(asRecord(rule), accountId, zoneId);
}
