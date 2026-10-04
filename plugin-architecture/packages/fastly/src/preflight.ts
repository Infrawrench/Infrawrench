/**
 * Credential preflight. A Fastly token can do what its scope allows
 * (`global`, `global:read`, `purge_select`, `purge_all`; verified against
 * Fastly's token data model, 2026-10), intersected with what its owner's role
 * allows (user, billing, engineer, superuser). `GET /tokens/self` reports the
 * scope and `GET /current_user` the role, so the probe is two reads plus one
 * minimal billing read, which is the only capability whose role rule is not
 * simply "can configure".
 */
import type {
  PolicyTemplate,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { FastlyContext } from "./api.js";
import { fastlyFetch, isPermissionError, statusOf } from "./api.js";

const TOKENS_URL = "https://manage.fastly.com/account/personal/tokens";

const P = {
  read: { id: "scope:global:read", label: "Token scope global:read (or global)" },
  global: { id: "scope:global", label: "Token scope global" },
  purgeSelect: { id: "scope:purge_select", label: "Token scope purge_select (or global)" },
  purgeAll: { id: "scope:purge_all", label: "Token scope purge_all (or global)" },
  billingRole: { id: "role:billing", label: "Owner role Billing or Superuser" },
  engineerRole: { id: "role:engineer", label: "Owner role Engineer or Superuser" },
} satisfies Record<string, PreflightPermission>;

export const FASTLY_PREFLIGHT: PreflightDeclaration = {
  capabilities: [
    {
      id: "inventory",
      label: "List services, TLS, stores and traffic",
      description:
        "Services, versions, domains, backends, logging endpoints, dictionaries, stores, TLS certificates and subscriptions, and the traffic charts.",
      requiredPermissions: [P.read],
      essential: true,
    },
    {
      id: "costs",
      label: "Cost data",
      description: "Monthly invoices and the month-to-date bill, broken down by product.",
      requiredPermissions: [P.read, P.billingRole],
    },
    {
      id: "purge",
      label: "Purge cache",
      description: "Purge by URL or surrogate key, and purge everything from a service.",
      requiredPermissions: [P.purgeSelect, P.purgeAll],
    },
    {
      id: "manage",
      label: "Change configuration",
      description:
        "Activate, deactivate and clone versions, edit services, dictionary and store items, enable products and revoke tokens.",
      requiredPermissions: [P.global, P.engineerRole],
    },
  ],
  templateFormat: { label: "API token settings", language: "text" },
};

interface TokenSelf {
  id?: string;
  name?: string;
  scope?: string;
  services?: string[];
  expires_at?: string;
}
interface CurrentUser {
  login?: string;
  name?: string;
  role?: string;
}

export function scopesOf(scope: string | undefined): Set<string> {
  return new Set((scope ?? "global").split(/\s+/).filter(Boolean));
}

/** Pure decision table, exported for tests. */
export function evaluate(scopes: Set<string>, role: string): PreflightCapabilityCheck[] {
  const global = scopes.has("global");
  const read = global || scopes.has("global:read");
  const purgeSelect = global || scopes.has("purge_select") || scopes.has("purge_all");
  const purgeAll = global || scopes.has("purge_all");
  const billing = role === "billing" || role === "superuser";
  const engineer = role === "engineer" || role === "superuser";
  const missing = (
    capabilityId: string,
    perms: PreflightPermission[],
    message?: string,
  ): PreflightCapabilityCheck =>
    perms.length === 0
      ? { capabilityId, status: "ok" }
      : {
          capabilityId,
          status: "missing",
          missingPermissions: perms,
          ...(message ? { message } : {}),
          helpLink: { label: "Manage API tokens", url: TOKENS_URL },
        };
  return [
    missing("inventory", read ? [] : [P.read]),
    missing(
      "costs",
      [...(read ? [] : [P.read]), ...(billing || !role ? [] : [P.billingRole])],
      !billing && role ? `The token's owner has the ${role} role.` : undefined,
    ),
    missing(
      "purge",
      [...(purgeSelect ? [] : [P.purgeSelect]), ...(purgeAll ? [] : [P.purgeAll])],
      purgeSelect && !purgeAll
        ? "URL and surrogate-key purges work; purging everything needs purge_all."
        : undefined,
    ),
    missing(
      "manage",
      [...(global ? [] : [P.global]), ...(engineer || !role ? [] : [P.engineerRole])],
      !engineer && role ? `The token's owner has the ${role} role.` : undefined,
    ),
  ];
}

export async function verifyFastlyCredentials(ctx: FastlyContext): Promise<PreflightResult> {
  let token: TokenSelf;
  try {
    token = (await fastlyFetch<TokenSelf>(ctx, "/tokens/self")) ?? {};
  } catch (err) {
    const message =
      statusOf(err) === 401
        ? "Fastly rejected the token. Check it was copied in full and has not expired or been revoked."
        : `Could not reach Fastly: ${err instanceof Error ? err.message : String(err)}`;
    return {
      checks: FASTLY_PREFLIGHT.capabilities.map((c) => ({
        capabilityId: c.id,
        status: "unknown" as const,
        message,
      })),
    };
  }
  const user = await fastlyFetch<CurrentUser>(ctx, "/current_user").catch(
    () => ({}) as CurrentUser,
  );
  const role = user.role ?? "";
  const checks = evaluate(scopesOf(token.scope), role);

  // The role table is Fastly's documented default; a billing probe settles it.
  const costIndex = checks.findIndex((c) => c.capabilityId === "costs");
  if (costIndex >= 0 && checks[costIndex]!.status === "ok") {
    try {
      await fastlyFetch<unknown>(ctx, "/billing/v3/invoices", { query: { limit: 1 } });
    } catch (err) {
      checks[costIndex] = isPermissionError(err)
        ? {
            capabilityId: "costs",
            status: "missing",
            missingPermissions: [P.billingRole],
            message: "Fastly refused the invoices request for this token.",
            helpLink: { label: "Manage API tokens", url: TOKENS_URL },
          }
        : {
            capabilityId: "costs",
            status: "unknown",
            message: err instanceof Error ? err.message : String(err),
          };
    }
  }

  const who = user.login ? `${user.login}${role ? ` (${role})` : ""}` : "";
  const scopeText = token.scope ? `scope ${token.scope}` : "";
  const limited = token.services?.length ? `limited to ${token.services.length} service(s)` : "";
  const identity = [who, token.name ? `token "${token.name}"` : "", scopeText, limited]
    .filter(Boolean)
    .join(", ");
  return { checks, ...(identity ? { identity } : {}) };
}

export function fastlyPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const want = new Set(capabilityIds);
  const scopes = new Set<string>();
  let role = "";
  if (want.has("manage")) {
    scopes.add("global");
    role = "Engineer (or Superuser)";
  } else {
    if (want.has("inventory") || want.has("costs")) scopes.add("global:read");
    if (want.has("purge")) scopes.add("purge_all");
  }
  if (want.has("costs")) role = role ? "Superuser" : "Billing (or Superuser)";
  const lines = [
    `Scope: ${[...scopes].join(" ") || "global:read"}`,
    `Owner role: ${role || "any (User is enough)"}`,
    "Services: all services (or only the services you want Infrawrench to see)",
    "Expiration: optional; Infrawrench shows the date on the Expiring page",
  ];
  return {
    formatLabel: "API token settings",
    language: "text",
    document: lines.join("\n"),
    instructions:
      "In Fastly, open Account, API tokens, Create Token, and choose these settings. A token can only do what its owner's role allows, so create it as a user with the role shown. purge_all also allows URL and surrogate-key purges.",
    helpLink: { label: "Create a Fastly API token", url: TOKENS_URL },
  };
}
