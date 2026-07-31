import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord } from "./shared.js";
import type {
  AccessRuleParam,
  PolicyCreateParams,
  PolicyUpdateParams,
} from "cloudflare/resources/zero-trust/access/applications/policies";
import type { DecisionParam } from "cloudflare/resources/zero-trust/access/applications/applications";

/**
 * The SDK's app-scoped `PolicyCreateParams` / `PolicyUpdateParams` only declare
 * the shared knobs (precedence, session duration, approval groups…) — the
 * `name`, `decision` and rule arrays that the endpoint actually requires are
 * missing from the generated request types even though they come back on
 * `PolicyCreateResponse` and are required on the reusable-policy equivalent in
 * `cloudflare/resources/zero-trust/access/policies`. Spell the missing body out
 * here so the payload is still fully typed instead of cast away.
 */
type PolicyRules = {
  name: string;
  decision: DecisionParam;
  include: Array<AccessRuleParam>;
  exclude?: Array<AccessRuleParam>;
  require?: Array<AccessRuleParam>;
};

/** The actions Access can take when a policy matches (`DecisionParam`). */
const DECISIONS = ["allow", "deny", "non_identity", "bypass"] as const;

const isDecision = (value: string): value is DecisionParam =>
  (DECISIONS as readonly string[]).includes(value);

/** Narrow a free-form decision field, defaulting to the least surprising `allow`. */
function toDecision(value: string | undefined): DecisionParam {
  return value !== undefined && isDecision(value) ? value : "allow";
}

function mapAccessPolicy(
  policy: Record<string, unknown>,
  accountId: string,
  appId: string,
): ResourceInstance {
  const id = String(policy["id"] ?? "");
  const name = String(policy["name"] ?? "");
  const decision = String(policy["decision"] ?? "");
  const formatRules = (rules: unknown): string => {
    if (!Array.isArray(rules)) return "";
    return (rules as Array<Record<string, unknown>>)
      .map((r) => {
        const entries = Object.entries(r).map(([k, v]) => {
          if (typeof v === "object" && v !== null) {
            const inner = v as Record<string, unknown>;
            return `${k}:${Object.values(inner).join(",")}`;
          }
          return `${k}:${String(v)}`;
        });
        return entries.join("+");
      })
      .join("; ");
  };
  return {
    id: `${accountId}:access-policy:${appId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "access-policy",
    accountId,
    displayName: name || `Policy ${id.slice(0, 8)}`,
    fields: {
      name,
      decision,
      precedence: Number(policy["precedence"] ?? 0),
      includeRules: formatRules(policy["include"]),
      excludeRules: formatRules(policy["exclude"]),
      requireRules: formatRules(policy["require"]),
      // The owning application is otherwise only encoded in the composite
      // external id, which the dependency graph can't take apart.
      applicationId: appId,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${appId}/${id}`,
    parentResourceId: `${accountId}:access-application:${appId}`,
    createdAt: String(policy["created_at"] ?? new Date().toISOString()),
    updatedAt: String(policy["updated_at"] ?? new Date().toISOString()),
  };
}

export async function listAllAccessPolicies(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const results: ResourceInstance[] = [];
  for await (const app of api.cf.zeroTrust.access.applications.list({ account_id })) {
    const appId = app.id ?? "";
    try {
      for await (const policy of api.cf.zeroTrust.access.applications.policies.list(appId, {
        account_id,
      })) {
        results.push(mapAccessPolicy(asRecord(policy), accountId, appId));
      }
    } catch {
      // Skip apps where we can't read policies
    }
  }
  return results;
}

/**
 * Turn a comma-separated list of emails/domains into Access include rules —
 * one rule per entry. A `@example.com` entry becomes an `email_domain` rule
 * (everyone at that domain); a bare `user@example.com` becomes an exact
 * `email` rule. Blank entries are dropped so trailing commas are harmless.
 */
function buildEmailRules(value: string): Array<AccessRuleParam> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) =>
      entry.startsWith("@")
        ? { email_domain: { domain: entry.slice(1) } }
        : { email: { email: entry } },
    );
}

export async function createAccessPolicy(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const appId = fields["appId"] || parentExternalId;
  if (!appId) throw new Error("Cloudflare plugin: appId is required to create an access policy");
  const includeRules = buildEmailRules(fields["includeEmail"] ?? "");
  if (includeRules.length === 0) {
    throw new Error("Cloudflare plugin: at least one include email or domain is required");
  }
  const body: PolicyCreateParams & PolicyRules = {
    account_id,
    name: fields["name"] ?? "",
    decision: toDecision(fields["decision"]),
    include: includeRules,
  };
  const policy = await api.cf.zeroTrust.access.applications.policies.create(appId, body);
  return mapAccessPolicy(asRecord(policy), accountId, appId);
}

export async function editAccessPolicy(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const [appId, policyId] = externalId.split("/");
  if (!appId || !policyId) throw new Error("Invalid access policy ID");
  // The include/exclude/require rule arrays are flattened to display strings on
  // read, so preserve them from the live policy and only edit name/decision/
  // precedence.
  const current = await api.cf.zeroTrust.access.applications.policies.get(appId, policyId, {
    account_id,
  });
  const body: PolicyUpdateParams & PolicyRules = {
    account_id,
    name: fields["name"] ?? current.name ?? "",
    decision: toDecision(fields["decision"] || current.decision),
    include: current.include ?? [],
    ...(current.exclude ? { exclude: current.exclude } : {}),
    ...(current.require ? { require: current.require } : {}),
    ...(fields["precedence"] && Number.isFinite(Number(fields["precedence"]))
      ? { precedence: Number(fields["precedence"]) }
      : {}),
  };
  const policy = await api.cf.zeroTrust.access.applications.policies.update(appId, policyId, body);
  return mapAccessPolicy(asRecord(policy), accountId, appId);
}
