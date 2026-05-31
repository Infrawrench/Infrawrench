import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { collectPerZone } from "./shared.js";
import type { RulesetCreateParams } from "cloudflare/resources/rulesets/rulesets";
import type { RuleCreateParams } from "cloudflare/resources/rulesets/rules";

/**
 * Generic Cloudflare "Rules engine" client. The modern rules products
 * (rate limiting, redirect rules, cache rules, …) are all entrypoint rulesets
 * keyed by a `phase`; each carries a `rules[]` array where every rule is
 * `{ id, expression, action, action_parameters?, ratelimit?, description, enabled }`.
 *
 * This mirrors firewall-rule-client.ts (the WAF-custom-rules phase) but is
 * parameterized by phase + a per-phase field mapper/builder so the four rule
 * types share one implementation. Each rule's externalId is
 * `<zoneId>/<rulesetId>/<ruleId>` so delete can address it directly.
 */
export interface RulePhaseSpec {
  /** Infrawrench resource type id, e.g. "rate-limit-rule". */
  resourceTypeId: string;
  /** Cloudflare ruleset phase, e.g. "http_ratelimit". */
  phase: string;
  /** Human ruleset name used when creating the entrypoint ruleset. */
  rulesetName: string;
  /** Friendly noun for error hints, e.g. "rate limiting rules". */
  errorNoun: string;
  /** Token-scope hint surfaced on auth errors, e.g. "Zone · Zone WAF:Read". */
  scopeHint: string;
  /** Pull display fields out of a raw CF rule object. */
  mapFields: (rule: Record<string, unknown>) => Record<string, string | number | boolean>;
  /** Build the CF rule body from create-form field values. */
  buildBody: (fields: Record<string, string>) => Record<string, unknown>;
  /** Choose a sidebar/display label for a rule. */
  displayName: (
    rule: Record<string, unknown>,
    fields: Record<string, string | number | boolean>,
  ) => string;
}

function mapRule(
  spec: RulePhaseSpec,
  rule: Record<string, unknown>,
  accountId: string,
  zoneId: string,
  rulesetId: string,
): ResourceInstance {
  const id = String(rule["id"] ?? "");
  const externalIdSuffix = `${zoneId}/${rulesetId}/${id}`;
  const fields = spec.mapFields(rule);
  return {
    id: `${accountId}:${spec.resourceTypeId}:${externalIdSuffix}`,
    pluginId: "cloudflare",
    resourceTypeId: spec.resourceTypeId,
    accountId,
    displayName: spec.displayName(rule, fields),
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: externalIdSuffix,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function findPhaseRuleset(
  api: CloudflareApi,
  zoneId: string,
  phase: string,
): Promise<Record<string, unknown> | null> {
  for await (const rs of api.cf.rulesets.list({ zone_id: zoneId })) {
    const raw = rs as unknown as Record<string, unknown>;
    if (raw["phase"] === phase) return raw;
  }
  return null;
}

export async function listAllPhaseRules(
  api: CloudflareApi,
  accountId: string,
  spec: RulePhaseSpec,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      const ruleset = await findPhaseRuleset(api, zoneId, spec.phase);
      if (ruleset) {
        const rsId = String(ruleset["id"]);
        const full = (await api.cf.rulesets.get(rsId, {
          zone_id: zoneId,
        })) as unknown as Record<string, unknown>;
        const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
        for (const rule of rules) {
          part.push(mapRule(spec, rule, accountId, zoneId, rsId));
        }
      }
      return part;
    },
    spec.errorNoun,
    spec.scopeHint,
  );
}

export async function createPhaseRule(
  api: CloudflareApi,
  accountId: string,
  spec: RulePhaseSpec,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId)
    throw new Error(`Cloudflare plugin: zoneId is required to create a ${spec.errorNoun}`);

  let rulesetId = "";
  try {
    const existing = await findPhaseRuleset(api, zoneId, spec.phase);
    if (existing) rulesetId = String(existing["id"] ?? "");
  } catch {
    // Ignore — fall back to creating the entrypoint ruleset below.
  }

  const ruleBody = spec.buildBody(fields);

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
      name: spec.rulesetName,
      kind: "zone",
      phase: spec.phase,
      rules: [ruleBody],
    } as unknown as RulesetCreateParams);
    const full = ruleset as unknown as Record<string, unknown>;
    rulesetId = String(full["id"] ?? "");
    const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
    result = rules[0] ?? full;
  }
  return mapRule(spec, result, accountId, zoneId, rulesetId);
}

export async function editPhaseRule(
  api: CloudflareApi,
  accountId: string,
  spec: RulePhaseSpec,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, rulesetId, ruleId] = externalId.split("/");
  if (!zoneId || !rulesetId || !ruleId) throw new Error("Invalid rule ID");
  // `buildBody` rebuilds the full rule body from the merged field set, so the
  // PATCH preserves every parameter the caller didn't change.
  const ruleBody = spec.buildBody(fields);
  const ruleset = await api.cf.rulesets.rules.edit(rulesetId, ruleId, {
    zone_id: zoneId,
    ...ruleBody,
  } as unknown as Parameters<typeof api.cf.rulesets.rules.edit>[2]);
  const full = ruleset as unknown as Record<string, unknown>;
  const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
  const updated = rules.find((r) => String(r["id"]) === ruleId) ?? { ...full, id: ruleId };
  return mapRule(spec, updated, accountId, zoneId, rulesetId);
}

export async function deletePhaseRule(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, rulesetId, ruleId] = externalId.split("/");
  if (!zoneId || !rulesetId || !ruleId) throw new Error("Invalid rule ID");
  await api.cf.rulesets.rules.delete(rulesetId, ruleId, { zone_id: zoneId });
}

// ───────────────────────── Per-phase specs ─────────────────────────

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Rules default to enabled; an explicit `"false"` (from an edit) disables them. */
const ruleEnabled = (fields: Record<string, string>): boolean => fields["enabled"] !== "false";

/** Rate limiting rules — `http_ratelimit` phase. */
export const RATE_LIMIT_SPEC: RulePhaseSpec = {
  resourceTypeId: "rate-limit-rule",
  phase: "http_ratelimit",
  rulesetName: "Rate Limiting Rules",
  errorNoun: "rate limiting rules",
  scopeHint: "Zone · Zone WAF:Read",
  mapFields: (rule) => {
    const rl = (rule["ratelimit"] as Record<string, unknown>) ?? {};
    const chars = Array.isArray(rl["characteristics"])
      ? (rl["characteristics"] as string[]).join(", ")
      : "";
    return {
      description: String(rule["description"] ?? ""),
      expression: String(rule["expression"] ?? ""),
      action: String(rule["action"] ?? "block"),
      enabled: Boolean(rule["enabled"] ?? true),
      requestsPerPeriod: Number(rl["requests_per_period"] ?? 0),
      period: Number(rl["period"] ?? 0),
      characteristics: chars,
    };
  },
  buildBody: (fields) => ({
    description: fields["description"] ?? "",
    expression: fields["expression"] ?? "",
    action: fields["action"] || "block",
    enabled: ruleEnabled(fields),
    ratelimit: {
      characteristics: (fields["characteristics"] || "ip.src")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
      period: num(fields["period"], 60),
      requests_per_period: num(fields["requestsPerPeriod"], 100),
      mitigation_timeout: num(fields["mitigationTimeout"], num(fields["period"], 60)),
    },
  }),
  displayName: (_rule, fields) =>
    String(fields["description"] || `${fields["requestsPerPeriod"]}/${fields["period"]}s`),
};

/** Redirect rules — `http_request_dynamic_redirect` phase. */
export const REDIRECT_SPEC: RulePhaseSpec = {
  resourceTypeId: "redirect-rule",
  phase: "http_request_dynamic_redirect",
  rulesetName: "Redirect Rules",
  errorNoun: "redirect rules",
  scopeHint: "Zone · Dynamic Redirect:Read",
  mapFields: (rule) => {
    const ap = (rule["action_parameters"] as Record<string, unknown>) ?? {};
    const fromValue = (ap["from_value"] as Record<string, unknown>) ?? {};
    const targetUrl = (fromValue["target_url"] as Record<string, unknown>) ?? {};
    return {
      description: String(rule["description"] ?? ""),
      expression: String(rule["expression"] ?? ""),
      action: String(rule["action"] ?? "redirect"),
      enabled: Boolean(rule["enabled"] ?? true),
      target: String(targetUrl["value"] ?? targetUrl["expression"] ?? ""),
      statusCode: Number(fromValue["status_code"] ?? 0),
      preserveQuery: Boolean(fromValue["preserve_query_string"] ?? false),
    };
  },
  buildBody: (fields) => ({
    description: fields["description"] ?? "",
    expression: fields["expression"] ?? "",
    action: "redirect",
    enabled: ruleEnabled(fields),
    action_parameters: {
      from_value: {
        target_url: { value: fields["target"] ?? "" },
        status_code: num(fields["statusCode"], 301),
        preserve_query_string: fields["preserveQuery"] === "true",
      },
    },
  }),
  displayName: (_rule, fields) => String(fields["description"] || fields["target"] || "Redirect"),
};

/** Cache rules — `http_request_cache_settings` phase. */
export const CACHE_SPEC: RulePhaseSpec = {
  resourceTypeId: "cache-rule",
  phase: "http_request_cache_settings",
  rulesetName: "Cache Rules",
  errorNoun: "cache rules",
  scopeHint: "Zone · Cache Settings:Read",
  mapFields: (rule) => {
    const ap = (rule["action_parameters"] as Record<string, unknown>) ?? {};
    const edgeTtl = (ap["edge_ttl"] as Record<string, unknown>) ?? {};
    return {
      description: String(rule["description"] ?? ""),
      expression: String(rule["expression"] ?? ""),
      action: String(rule["action"] ?? "set_cache_settings"),
      enabled: Boolean(rule["enabled"] ?? true),
      cache: Boolean(ap["cache"] ?? false),
      ...(edgeTtl["default"] !== undefined ? { edgeTtl: Number(edgeTtl["default"]) } : {}),
    };
  },
  buildBody: (fields) => {
    const cache = fields["cache"] !== "false";
    const ap: Record<string, unknown> = { cache };
    // Only attach an edge TTL override when caching is on and a value is given.
    if (cache && fields["edgeTtl"] && Number.isFinite(Number(fields["edgeTtl"]))) {
      ap["edge_ttl"] = { mode: "override_origin", default: Number(fields["edgeTtl"]) };
    }
    return {
      description: fields["description"] ?? "",
      expression: fields["expression"] ?? "",
      action: "set_cache_settings",
      enabled: ruleEnabled(fields),
      action_parameters: ap,
    };
  },
  displayName: (_rule, fields) =>
    String(fields["description"] || (fields["cache"] ? "Cache" : "Bypass cache")),
};
