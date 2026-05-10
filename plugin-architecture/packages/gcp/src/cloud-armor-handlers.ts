import type { ResourceInstance } from "@infrawrench/plugin-base";
import { parseFormArg } from "./utils.js";

export interface CloudArmorContext {
  project: string;
  token: () => Promise<string>;
}

export interface CloudArmorRuleSummary {
  priority: number;
  description: string;
  action: string;
  preview: boolean;
  mode: "basic" | "advanced";
  match: string;
  responseCode: string;
}

export interface CloudArmorPolicyFullResult {
  rules: CloudArmorRuleSummary[];
  fingerprint: string;
  error: string;
}

export interface CloudArmorTargetSummary {
  /** Backend service short name. */
  name: string;
  /** Region — empty string for global backend services. */
  region: string;
}

export interface CloudArmorTargetsResult {
  targets: CloudArmorTargetSummary[];
  error: string;
}

function policyName(resource: ResourceInstance): string {
  const ext = resource.externalId ?? "";
  // externalId is "{project}/{name}" — fall back to fields.name.
  const slash = ext.indexOf("/");
  if (slash >= 0) return ext.slice(slash + 1);
  return String(resource.fields["name"] ?? resource.displayName);
}

async function gcpFetch(
  ctx: CloudArmorContext,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const tok = await ctx.token();
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

interface RawRule {
  priority?: number;
  description?: string;
  action?: string;
  preview?: boolean;
  match?: {
    versionedExpr?: string;
    config?: { srcIpRanges?: string[] };
    expr?: { expression?: string };
  };
  rateLimitOptions?: Record<string, unknown>;
  headerAction?: Record<string, unknown>;
  redirectOptions?: Record<string, unknown>;
  // For deny-with-status, GCP nests an integer under deny<status>. New APIs
  // surface the response code via deniedHttpStatus or part of the action verb
  // ("deny(403)" historically). v1 returns action like "deny(403)".
}

function ruleResponseCode(action: string): string {
  // v1 returns action strings like "deny(403)", "deny(404)", "deny(502)" — the
  // status code lives inside parentheses. Allow / redirect / etc. don't have one.
  const m = /^deny\((\d+)\)$/.exec(action);
  return m ? (m[1] ?? "") : "";
}

function summariseRule(raw: RawRule): CloudArmorRuleSummary {
  const match = raw.match ?? {};
  const isBasic = match.versionedExpr === "SRC_IPS_V1" || Boolean(match.config?.srcIpRanges);
  const matchStr = isBasic
    ? (match.config?.srcIpRanges ?? []).join(", ")
    : String(match.expr?.expression ?? "");
  return {
    priority: Number(raw.priority ?? 0),
    description: String(raw.description ?? ""),
    action: String(raw.action ?? ""),
    preview: Boolean(raw.preview),
    mode: isBasic ? "basic" : "advanced",
    match: matchStr,
    responseCode: ruleResponseCode(String(raw.action ?? "")),
  };
}

export async function fetchCloudArmorPolicyFull(
  ctx: CloudArmorContext,
  resource: ResourceInstance,
): Promise<CloudArmorPolicyFullResult> {
  const name = policyName(resource);
  const res = await gcpFetch(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/securityPolicies/${name}`,
  );
  if (!res.ok) {
    return {
      rules: [],
      fingerprint: "",
      error: `GCP Compute API ${res.status}: ${await res.text()}`,
    };
  }
  const data = (await res.json()) as { rules?: RawRule[]; fingerprint?: string };
  const rules = (data.rules ?? []).map(summariseRule).sort((a, b) => a.priority - b.priority);
  return { rules, fingerprint: String(data.fingerprint ?? ""), error: "" };
}

export async function listCloudArmorTargets(
  ctx: CloudArmorContext,
  resource: ResourceInstance,
): Promise<CloudArmorTargetsResult> {
  const name = policyName(resource);
  // Cloud Armor policies attach to backend services via the backend service's
  // securityPolicy field — there's no reverse-lookup endpoint, so we scan
  // aggregated/backendServices and filter by suffix match.
  const res = await gcpFetch(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/aggregated/backendServices?maxResults=500`,
  );
  if (!res.ok) {
    return { targets: [], error: `GCP Compute API ${res.status}: ${await res.text()}` };
  }
  const data = (await res.json()) as {
    items?: Record<string, { backendServices?: Array<Record<string, unknown>> }>;
  };
  const targets: CloudArmorTargetSummary[] = [];
  const policySuffix = `/securityPolicies/${name}`;
  for (const [scope, group] of Object.entries(data.items ?? {})) {
    for (const bs of group.backendServices ?? []) {
      const policy = String(bs["securityPolicy"] ?? "");
      if (!policy || !policy.endsWith(policySuffix)) continue;
      // scope is e.g. "global" or "regions/us-central1"
      const region = scope.startsWith("regions/") ? scope.slice("regions/".length) : "";
      targets.push({ name: String(bs["name"] ?? ""), region });
    }
  }
  return { targets, error: "" };
}

interface AddRuleOpts {
  priority: number;
  description: string;
  mode: "basic" | "advanced";
  /** Comma-separated IP ranges (basic) or "*". */
  match: string;
  action: "allow" | "deny";
  /** Only used when action is "deny". */
  responseCode: string;
  preview: boolean;
}

function buildRuleBody(opts: AddRuleOpts): Record<string, unknown> {
  const ranges = opts.match
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const match: Record<string, unknown> =
    opts.mode === "basic"
      ? {
          versionedExpr: "SRC_IPS_V1",
          // GCP Cloud Armor uses "*" expanded to ["*"] internally; passing
          // ["*"] matches all IPs.
          config: { srcIpRanges: ranges.length > 0 ? ranges : ["*"] },
        }
      : { expr: { expression: opts.match } };
  const action = opts.action === "deny" ? `deny(${opts.responseCode || "403"})` : "allow";
  const body: Record<string, unknown> = {
    priority: opts.priority,
    description: opts.description,
    match,
    action,
  };
  if (opts.preview) body["preview"] = true;
  return body;
}

export async function addCloudArmorRule(
  ctx: CloudArmorContext,
  resource: ResourceInstance,
  opts: AddRuleOpts,
): Promise<void> {
  const name = policyName(resource);
  const body = buildRuleBody(opts);
  const res = await gcpFetch(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/securityPolicies/${name}/addRule`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
  }
}

export async function deleteCloudArmorRule(
  ctx: CloudArmorContext,
  resource: ResourceInstance,
  priority: number,
): Promise<void> {
  const name = policyName(resource);
  const res = await gcpFetch(
    ctx,
    `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/securityPolicies/${name}/removeRule?priority=${priority}`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
  }
}

async function setBackendServiceSecurityPolicy(
  ctx: CloudArmorContext,
  backendName: string,
  region: string,
  policyUrl: string | null,
): Promise<void> {
  const base =
    region && region !== "global"
      ? `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/regions/${region}/backendServices/${backendName}`
      : `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/backendServices/${backendName}`;
  const res = await gcpFetch(ctx, `${base}/setSecurityPolicy`, {
    method: "POST",
    body: JSON.stringify({ securityPolicy: policyUrl }),
  });
  if (!res.ok) {
    throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
  }
}

export async function attachCloudArmorTarget(
  ctx: CloudArmorContext,
  resource: ResourceInstance,
  backendName: string,
  region: string,
): Promise<void> {
  const name = policyName(resource);
  const policyUrl = `https://www.googleapis.com/compute/v1/projects/${ctx.project}/global/securityPolicies/${name}`;
  await setBackendServiceSecurityPolicy(ctx, backendName, region, policyUrl);
}

export async function detachCloudArmorTarget(
  ctx: CloudArmorContext,
  backendName: string,
  region: string,
): Promise<void> {
  await setBackendServiceSecurityPolicy(ctx, backendName, region, null);
}

export async function executeCloudArmorCommand(
  ctx: CloudArmorContext,
  resource: ResourceInstance,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  switch (command) {
    case "addRule": {
      const vals = parseFormArg(args[0]);
      const mode = vals["mode"] === "advanced" ? "advanced" : "basic";
      await addCloudArmorRule(ctx, resource, {
        priority: Number(vals["priority"] ?? 1000),
        description: vals["description"] ?? "",
        mode,
        match: vals["match"] ?? "",
        action: vals["action"] === "allow" ? "allow" : "deny",
        responseCode: vals["responseCode"] ?? "403",
        preview: vals["preview"] === "true",
      });
      return null;
    }
    case "deleteRule": {
      const vals = parseFormArg(args[0]);
      await deleteCloudArmorRule(ctx, resource, Number(vals["priority"] ?? 0));
      return null;
    }
    case "addTarget": {
      const vals = parseFormArg(args[0]);
      // resource-picker submits the externalId as the value. Backend service
      // externalIds are the bare name (set by the lister); region comes
      // alongside, defaulting to global.
      await attachCloudArmorTarget(
        ctx,
        resource,
        vals["backendService"] ?? "",
        vals["region"] ?? "",
      );
      return null;
    }
    case "removeTarget": {
      const vals = parseFormArg(args[0]);
      await detachCloudArmorTarget(ctx, vals["backendService"] ?? "", vals["region"] ?? "");
      return null;
    }
    default:
      throw new Error(`Unknown Cloud Armor command: ${command}`);
  }
}
