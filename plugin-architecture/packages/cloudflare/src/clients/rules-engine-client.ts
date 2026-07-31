import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone, resolveZoneName } from "./shared.js";
import type { PhaseParam, RulesetCreateParams } from "cloudflare/resources/rulesets/rulesets";

/**
 * One rule as the SDK types it: the discriminated union over the rule `action`,
 * shared by `rulesets.create({ rules })` and `rulesets.rules.create/edit`
 * (which additionally take the zone id).
 *
 * Taking the element type of `RulesetCreateParams["rules"]` rather than
 * re-declaring it means every `buildBody` below is checked against the real
 * per-action parameter shapes — the redirect status code, the edge-TTL mode,
 * the rate-limit characteristics — instead of being asserted into place.
 */
export type CloudflareRuleBody = NonNullable<RulesetCreateParams["rules"]>[number];

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
  phase: PhaseParam;
  /** Human ruleset name used when creating the entrypoint ruleset. */
  rulesetName: string;
  /** Friendly noun for error hints, e.g. "rate limiting rules". */
  errorNoun: string;
  /** Token-scope hint surfaced on auth errors, e.g. "Zone · Zone WAF:Read". */
  scopeHint: string;
  /** Pull display fields out of a raw CF rule object. */
  mapFields: (rule: Record<string, unknown>) => Record<string, string | number | boolean>;
  /** Build the CF rule body from create-form field values. */
  buildBody: (fields: Record<string, string>) => CloudflareRuleBody;
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
  zoneName: string,
  rulesetId: string,
): ResourceInstance {
  const id = String(rule["id"] ?? "");
  const externalIdSuffix = `${zoneId}/${rulesetId}/${id}`;
  // Every phase gets `zoneName` on top of its own fields — the zone is only
  // otherwise encoded in the external id, which the dependency graph can't read.
  const fields = { ...spec.mapFields(rule), zoneName };
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
  phase: PhaseParam,
): Promise<Record<string, unknown> | null> {
  for await (const rs of api.cf.rulesets.list({ zone_id: zoneId })) {
    const raw = asRecord(rs);
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
    async (zoneId, zoneName) => {
      const part: ResourceInstance[] = [];
      const ruleset = await findPhaseRuleset(api, zoneId, spec.phase);
      if (ruleset) {
        const rsId = String(ruleset["id"]);
        const full = asRecord(
          await api.cf.rulesets.get(rsId, {
            zone_id: zoneId,
          }),
        );
        const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
        for (const rule of rules) {
          part.push(mapRule(spec, rule, accountId, zoneId, zoneName, rsId));
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
    });
    const full = asRecord(ruleset);
    const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
    result = rules[rules.length - 1] ?? full;
  } else {
    const ruleset = await api.cf.rulesets.create({
      zone_id: zoneId,
      name: spec.rulesetName,
      kind: "zone",
      phase: spec.phase,
      rules: [ruleBody],
    });
    const full = asRecord(ruleset);
    rulesetId = String(full["id"] ?? "");
    const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
    result = rules[0] ?? full;
  }
  return mapRule(spec, result, accountId, zoneId, await resolveZoneName(api, zoneId), rulesetId);
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
  });
  const full = asRecord(ruleset);
  const rules = (full["rules"] as Array<Record<string, unknown>>) ?? [];
  const updated = rules.find((r) => String(r["id"]) === ruleId) ?? { ...full, id: ruleId };
  return mapRule(spec, updated, accountId, zoneId, await resolveZoneName(api, zoneId), rulesetId);
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

/**
 * Actions the `http_ratelimit` phase accepts, mirroring the picker in
 * `create-configs.ts`. `action` is the discriminant of the SDK's rule union
 * (cloudflare/resources/rulesets/rules.d.ts:8537), so a plain `string` can't
 * be handed to it. Unrecognized values fall back to `block`, the picker's
 * default — a rate limit that blocks is the conservative choice, and every
 * alternative here is strictly weaker.
 */
const RATE_LIMIT_ACTIONS = [
  "block",
  "challenge",
  "js_challenge",
  "managed_challenge",
  "log",
] as const;
type RateLimitAction = (typeof RATE_LIMIT_ACTIONS)[number];
const rateLimitAction = (value: string | undefined): RateLimitAction => {
  const isRateLimitAction = (v: string): v is RateLimitAction =>
    (RATE_LIMIT_ACTIONS as readonly string[]).includes(v);
  return value !== undefined && isRateLimitAction(value) ? value : "block";
};

/**
 * Status codes Cloudflare's dynamic-redirect action accepts
 * (`RedirectRuleParam.ActionParameters.FromValue.status_code`,
 * cloudflare/resources/rulesets/rules.d.ts:2487). Anything else falls back to
 * 301, the picker's default.
 */
const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308] as const;
type RedirectStatusCode = (typeof REDIRECT_STATUS_CODES)[number];
const redirectStatusCode = (value: string | undefined): RedirectStatusCode => {
  const isRedirectStatusCode = (n: number): n is RedirectStatusCode =>
    (REDIRECT_STATUS_CODES as readonly number[]).includes(n);
  const parsed = Number(value);
  return isRedirectStatusCode(parsed) ? parsed : 301;
};

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
    action: rateLimitAction(fields["action"]),
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
        status_code: redirectStatusCode(fields["statusCode"]),
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
    // Only attach an edge TTL override when caching is on and a value is given.
    const edgeTtl = Number(fields["edgeTtl"]);
    const overrideEdgeTtl = cache && Boolean(fields["edgeTtl"]) && Number.isFinite(edgeTtl);
    return {
      description: fields["description"] ?? "",
      expression: fields["expression"] ?? "",
      action: "set_cache_settings",
      enabled: ruleEnabled(fields),
      action_parameters: {
        cache,
        ...(overrideEdgeTtl ? { edge_ttl: { mode: "override_origin", default: edgeTtl } } : {}),
      },
    };
  },
  displayName: (_rule, fields) =>
    String(fields["description"] || (fields["cache"] ? "Cache" : "Bypass cache")),
};
