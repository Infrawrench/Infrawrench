import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone, resolveZoneName } from "./shared.js";

/**
 * Actions the `http_request_firewall_custom` phase accepts.
 *
 * `action` is the discriminant of the SDK's rule union (`RuleCreateParams`,
 * cloudflare/resources/rulesets/rules.d.ts:8537), so it has to be one of the
 * SDK's literals — a plain `string` cannot be handed to the SDK. This list is
 * the subset the WAF-custom-rules picker in `create-configs.ts` offers, minus
 * anything the rules engine doesn't model.
 */
const FIREWALL_ACTIONS = [
  "block",
  "challenge",
  "js_challenge",
  "managed_challenge",
  "log",
  "skip",
] as const;
type FirewallAction = (typeof FIREWALL_ACTIONS)[number];
const isFirewallAction = (value: string): value is FirewallAction =>
  (FIREWALL_ACTIONS as readonly string[]).includes(value);

/**
 * Narrow a form-supplied action string to a rules-engine action.
 *
 * A missing action defaults to `block` (the picker's first option, and the
 * only safe default for a WAF rule). An action that is present but not
 * recognized throws rather than silently falling back: quietly turning, say,
 * `allow` into `block` would invert the rule's meaning.
 */
function firewallAction(value: string | undefined): FirewallAction {
  const action = value === undefined || value === "" ? "block" : value;
  if (!isFirewallAction(action)) {
    throw new Error(
      `Cloudflare plugin: "${action}" is not a valid WAF custom-rule action — ` +
        `Cloudflare accepts ${FIREWALL_ACTIONS.join(", ")}.`,
    );
  }
  return action;
}

function mapFirewallRule(
  rule: Record<string, unknown>,
  accountId: string,
  zoneId: string,
  zoneName: string,
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
      zoneName,
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
    const raw = asRecord(rs);
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
    async (zoneId, zoneName) => {
      const part: ResourceInstance[] = [];
      const customRuleset = await findCustomRuleset(api, zoneId);
      if (customRuleset) {
        const rsId = String(customRuleset["id"]);
        const fullRuleset = await api.cf.rulesets.get(rsId, { zone_id: zoneId });
        const full = asRecord(fullRuleset);
        const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
        for (const rule of rules) {
          part.push(mapFirewallRule(rule, accountId, zoneId, zoneName, rsId));
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

  const ruleBody = {
    description: fields["description"] ?? "",
    expression: fields["expression"] ?? "",
    action: firewallAction(fields["action"]),
    enabled: true,
  };

  let result: Record<string, unknown>;
  if (rulesetId) {
    const ruleset = await api.cf.rulesets.rules.create(rulesetId, {
      zone_id: zoneId,
      ...ruleBody,
    });
    const full = asRecord(ruleset);
    const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
    result = rules[rules.length - 1] ?? full;
  } else {
    const ruleset = await api.cf.rulesets.create({
      zone_id: zoneId,
      name: "Custom Firewall Rules",
      kind: "zone",
      phase: "http_request_firewall_custom",
      rules: [ruleBody],
    });
    const full = asRecord(ruleset);
    rulesetId = String(full["id"] ?? "");
    const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
    result = rules[0] ?? full;
  }
  return mapFirewallRule(result, accountId, zoneId, await resolveZoneName(api, zoneId), rulesetId);
}

export async function editFirewallRule(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, rulesetId, ruleId] = externalId.split("/");
  if (!zoneId || !rulesetId || !ruleId) throw new Error("Invalid firewall rule ID");
  const ruleBody = {
    description: fields["description"] ?? "",
    expression: fields["expression"] ?? "",
    action: firewallAction(fields["action"]),
    enabled: fields["enabled"] !== "false",
  };
  const ruleset = await api.cf.rulesets.rules.edit(rulesetId, ruleId, {
    zone_id: zoneId,
    ...ruleBody,
  });
  const full = asRecord(ruleset);
  const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
  const updated = rules.find((r) => String(r["id"]) === ruleId) ?? { ...full, id: ruleId };
  return mapFirewallRule(updated, accountId, zoneId, await resolveZoneName(api, zoneId), rulesetId);
}

export async function deleteFirewallRule(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, rulesetId, ruleId] = externalId.split("/");
  if (!zoneId || !rulesetId || !ruleId) throw new Error("Invalid firewall rule ID");
  await api.cf.rulesets.rules.delete(rulesetId, ruleId, { zone_id: zoneId });
}
