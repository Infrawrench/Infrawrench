/**
 * Credential preflight + API-token template for Cloudflare.
 *
 * Cloudflare tokens don't expose their permission groups through the verify
 * endpoint, so the probe is a handful of cheap read calls, one per
 * capability:
 *   - `GET /user/tokens/verify` — token validity/expiry (verified 2026:
 *     Bearer auth, `result.status` in {active, disabled, expired}; rejects
 *     account-owned tokens with code 1000, which we treat as "can't verify
 *     here" rather than invalid).
 *   - `GET /zones?per_page=1` + `GET /accounts?per_page=1` — resources.
 *   - GraphQL `viewer.budget` — Analytics Read.
 *   - `GET /accounts/{id}/billable-usage/info` — Billing Read (the same
 *     endpoint cost collection reads coverage from).
 *
 * The "policy template" is Cloudflare's documented token-template deep link:
 * dash.cloudflare.com/profile/api-tokens with a URL-encoded
 * `permissionGroupKeys` JSON array of `{ key, type }` — plus the
 * human-readable permission-group list for anyone building the token by hand.
 */
import type {
  PolicyTemplate,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "@infrawrench/plugin-base";

const API = "https://api.cloudflare.com/client/v4";

const RESOURCES_PERMISSIONS: PreflightPermission[] = [
  { id: "Zone Read", label: "List zones (underpins every zone-scoped resource)" },
  { id: "Account Settings Read", label: "Read account-level resources (Workers, R2, KV, D1…)" },
];

const METRICS_PERMISSIONS: PreflightPermission[] = [
  { id: "Analytics Read", label: "Read zone analytics (traffic, cache, threats)" },
  { id: "Account Analytics Read", label: "Read account analytics (Workers metrics)" },
];

const COSTS_PERMISSIONS: PreflightPermission[] = [
  { id: "Billing Read", label: "Read billable usage for cost graphs" },
];

export const cloudflarePreflight: PreflightDeclaration = {
  capabilities: [
    {
      id: "resources",
      label: "Resource inventory",
      description:
        "Zones, DNS, Workers, R2, KV and the other resource types the plugin lists. Individual resource types may need further per-feature scopes.",
      requiredPermissions: RESOURCES_PERMISSIONS,
      essential: true,
    },
    {
      id: "metrics",
      label: "Metrics & dashboards",
      description: "Zone and Workers analytics for resource dashboards.",
      requiredPermissions: METRICS_PERMISSIONS,
    },
    {
      id: "costs",
      label: "Cost reporting",
      description: "Billing-cycle spend via the Billable Usage API.",
      requiredPermissions: COSTS_PERMISSIONS,
    },
  ],
  templateFormat: { label: "Cloudflare API token template", language: "text" },
};

/**
 * Token-creator `permissionGroupKeys` entries per capability. The
 * `resources` set mirrors the manifest's create-token deep link (edit
 * scopes — the plugin can create and delete resources).
 */
const TEMPLATE_SCOPES: Record<string, Array<{ key: string; type: string; name: string }>> = {
  resources: [
    { key: "zone", type: "edit", name: "Zone" },
    { key: "zone_settings", type: "edit", name: "Zone Settings" },
    { key: "dns", type: "edit", name: "DNS" },
    { key: "ssl_and_certificates", type: "edit", name: "SSL and Certificates" },
    { key: "page_rules", type: "edit", name: "Page Rules" },
    { key: "load_balancers", type: "edit", name: "Load Balancing" },
    { key: "access", type: "edit", name: "Access: Apps and Policies" },
    { key: "workers_scripts", type: "edit", name: "Workers Scripts" },
    { key: "workers_ai", type: "read", name: "Workers AI" },
    { key: "workers_kv_storage", type: "edit", name: "Workers KV Storage" },
    { key: "workers_r2", type: "edit", name: "Workers R2 Storage" },
    { key: "workers_routes", type: "edit", name: "Workers Routes" },
    { key: "d1", type: "edit", name: "D1" },
    { key: "queues", type: "edit", name: "Queues" },
    { key: "hyperdrive", type: "edit", name: "Hyperdrive" },
    { key: "argotunnel", type: "edit", name: "Cloudflare Tunnel" },
    { key: "waiting_rooms", type: "edit", name: "Waiting Rooms" },
    { key: "firewall_services", type: "edit", name: "Firewall Services" },
    { key: "spectrum", type: "edit", name: "Spectrum" },
    { key: "logs", type: "edit", name: "Logs" },
    { key: "transform_rules", type: "edit", name: "Transform Rules" },
    { key: "health_checks", type: "edit", name: "Health Checks" },
    { key: "turnstile", type: "edit", name: "Turnstile" },
    { key: "notifications", type: "edit", name: "Notifications" },
    { key: "vectorize", type: "edit", name: "Vectorize" },
    { key: "ai_gateway", type: "edit", name: "AI Gateway" },
  ],
  metrics: [
    { key: "analytics", type: "read", name: "Analytics" },
    { key: "account_analytics", type: "read", name: "Account Analytics" },
  ],
  costs: [{ key: "billing", type: "read", name: "Billing" }],
};

/** Build the token template: permission-group list + prefilled creator link. */
export function buildCloudflarePolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const selected = cloudflarePreflight.capabilities.filter((c) => capabilityIds.includes(c.id));
  const scopes = selected.flatMap((c) => TEMPLATE_SCOPES[c.id] ?? []);
  const url = `https://dash.cloudflare.com/profile/api-tokens?${new URLSearchParams({
    permissionGroupKeys: JSON.stringify(scopes.map(({ key, type }) => ({ key, type }))),
    accountId: "*",
    zoneId: "all",
    name: "Infrawrench",
  }).toString()}`;
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const lines = [
    "Cloudflare API token — permission groups (all accounts, all zones):",
    "",
    ...scopes.map((s) => `  ${s.name} · ${capitalize(s.type)}`),
    "",
    "Create it with these scopes pre-filled:",
    url,
  ];
  return {
    formatLabel: "Cloudflare API token template",
    language: "text",
    document: `${lines.join("\n")}\n`,
    instructions:
      "Open the link (or Cloudflare dashboard → My Profile → API Tokens → Create Token), review the pre-filled permission groups, create the token, and paste it as the account's API Token.",
    helpLink: { label: "Open Cloudflare's token creator with these scopes", url },
  };
}

const TOKENS_HELP_LINK = {
  label: "Manage API tokens in the Cloudflare dashboard",
  url: "https://dash.cloudflare.com/profile/api-tokens",
};

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

/** 401/403, or Cloudflare's auth-failure body codes (10000 generic, 9109 scope). */
function isAuthFailure(status: number, body: CfEnvelope<unknown> | null): boolean {
  if (status === 401 || status === 403) return true;
  return (body?.errors ?? []).some((e) => e.code === 10000 || e.code === 9109);
}

async function cfGet<T>(
  token: string,
  path: string,
): Promise<{
  status: number;
  body: CfEnvelope<T> | null;
}> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  let body: CfEnvelope<T> | null = null;
  try {
    body = (await res.json()) as CfEnvelope<T>;
  } catch {
    // non-JSON body — status alone decides
  }
  return { status: res.status, body };
}

function shortMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.length > 300 ? `${raw.slice(0, 299)}…` : raw;
}

/** Human summary of a failed (non-auth) envelope response, for `unknown` checks. */
function probeFailureMessage(label: string, status: number, body: CfEnvelope<unknown> | null) {
  const msg = (body?.errors ?? [])
    .map((e) => e.message)
    .filter(Boolean)
    .join("; ");
  return msg ? `${label}: ${msg}` : `${label} returned status ${status}.`;
}

function unknownChecks(message: string): PreflightCapabilityCheck[] {
  return cloudflarePreflight.capabilities.map((c) => ({
    capabilityId: c.id,
    status: "unknown" as const,
    message,
  }));
}

export async function runCloudflarePreflight(token: string): Promise<PreflightResult> {
  let identity: string | undefined;

  // 1. Token validity. Account-owned tokens are rejected here (code 1000)
  //    without being invalid — skip ahead and let the probes decide.
  try {
    const verify = await cfGet<{ id?: string; status?: string; expires_on?: string }>(
      token,
      "/user/tokens/verify",
    );
    const status = verify.body?.result?.status;
    if (verify.body?.success && status) {
      if (status !== "active") {
        return {
          checks: cloudflarePreflight.capabilities.map((c) => ({
            capabilityId: c.id,
            status: "missing" as const,
            missingPermissions: [],
            message: `The API token is ${status}. Create a fresh token and update the account credentials.`,
            helpLink: TOKENS_HELP_LINK,
          })),
        };
      }
      identity = verify.body.result?.id ? `API token ${verify.body.result.id}` : undefined;
    }
  } catch (e) {
    return { checks: unknownChecks(shortMessage(e)) };
  }

  const checks: PreflightCapabilityCheck[] = [];
  let accountId: string | null = null;

  // 2. Resources: zone list + account list. Same three-way handling as the
  //    costs probe: ok only on explicit success, missing only on authorization
  //    failures, unknown (with detail) for everything else — a 500 or a
  //    malformed body is not evidence the permission is granted.
  try {
    const missing: PreflightPermission[] = [];
    const probeFailures: string[] = [];
    const zones = await cfGet<unknown[]>(token, "/zones?per_page=1");
    if (!zones.body?.success) {
      if (isAuthFailure(zones.status, zones.body)) {
        missing.push(RESOURCES_PERMISSIONS[0]!);
      } else {
        probeFailures.push(probeFailureMessage("Zone list", zones.status, zones.body));
      }
    }
    const accounts = await cfGet<Array<{ id?: string }>>(token, "/accounts?per_page=1");
    if (accounts.body?.success) {
      accountId = accounts.body.result?.[0]?.id ?? null;
    } else if (isAuthFailure(accounts.status, accounts.body)) {
      missing.push(RESOURCES_PERMISSIONS[1]!);
    } else {
      probeFailures.push(probeFailureMessage("Account list", accounts.status, accounts.body));
    }
    if (missing.length > 0) {
      checks.push({
        capabilityId: "resources",
        status: "missing",
        missingPermissions: missing,
        helpLink: TOKENS_HELP_LINK,
      });
    } else if (probeFailures.length > 0) {
      checks.push({
        capabilityId: "resources",
        status: "unknown",
        message: probeFailures.join(" "),
      });
    } else {
      checks.push({ capabilityId: "resources", status: "ok" });
    }
  } catch (e) {
    checks.push({ capabilityId: "resources", status: "unknown", message: shortMessage(e) });
  }

  // 3. Metrics: the cheapest possible GraphQL query. Missing only on an
  //    authorization failure; a 5xx, a non-JSON body or GraphQL-level errors
  //    without an auth status are `unknown`, not evidence of a missing scope.
  try {
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { budget } }" }),
    });
    interface GraphqlProbeBody {
      data?: { viewer?: unknown } | null;
      errors?: Array<{ message?: string }> | null;
    }
    let body: GraphqlProbeBody | null = null;
    try {
      body = (await res.json()) as GraphqlProbeBody;
    } catch {
      // non-JSON body — handled below
    }
    if (res.status === 401 || res.status === 403) {
      checks.push({
        capabilityId: "metrics",
        status: "missing",
        missingPermissions: METRICS_PERMISSIONS,
        helpLink: TOKENS_HELP_LINK,
      });
    } else if (res.ok && body?.data?.viewer != null) {
      checks.push({ capabilityId: "metrics", status: "ok" });
    } else {
      const msg = (body?.errors ?? [])
        .map((e) => e?.message)
        .filter(Boolean)
        .join("; ");
      checks.push({
        capabilityId: "metrics",
        status: "unknown",
        message: msg || `GraphQL analytics probe returned status ${res.status}.`,
      });
    }
  } catch (e) {
    checks.push({ capabilityId: "metrics", status: "unknown", message: shortMessage(e) });
  }

  // 4. Costs: billable-usage coverage info needs an account id to probe.
  if (!accountId) {
    checks.push({
      capabilityId: "costs",
      status: "unknown",
      message:
        "Couldn't resolve an account id to probe billing with — grant Account Settings Read and re-run.",
    });
  } else {
    try {
      const info = await cfGet<unknown>(token, `/accounts/${accountId}/billable-usage/info`);
      if (info.body?.success) {
        checks.push({ capabilityId: "costs", status: "ok" });
      } else if (isAuthFailure(info.status, info.body)) {
        checks.push({
          capabilityId: "costs",
          status: "missing",
          missingPermissions: COSTS_PERMISSIONS,
          helpLink: TOKENS_HELP_LINK,
        });
      } else {
        const msg = info.body?.errors
          ?.map((e) => e.message)
          .filter(Boolean)
          .join("; ");
        checks.push({
          capabilityId: "costs",
          status: "unknown",
          message: msg || `Billable Usage API returned status ${info.status}.`,
        });
      }
    } catch (e) {
      checks.push({ capabilityId: "costs", status: "unknown", message: shortMessage(e) });
    }
  }

  return { ...(identity ? { identity } : {}), checks };
}
