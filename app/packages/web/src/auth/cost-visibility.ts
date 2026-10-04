/**
 * Cost visibility on the HTTP and tool surfaces.
 *
 * The scope itself is applied by the ClickHouse readers (server-core
 * `cost/visibility-context.ts`); this module is what *establishes* it for a
 * request. `costVisibilityMiddleware` runs last in the org-tree chain, after
 * the principal and its permissions are known, resolves the caller's scope,
 * refuses the handful of org-wide surfaces a scoped principal must not reach,
 * and runs the rest of the request inside the scope. Tool dispatch (chat,
 * MCP) and Slack commands call {@link withPrincipalCostVisibility} for the
 * same effect outside the middleware chain.
 */
import { resolveSharingPrincipal, runWithSharingPrincipal } from "../services/object-sharing";
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { COST_SCOPE_RESTRICTED_CODE } from "@infrawrench/client-core";
import {
  resolveCostVisibility,
  type CostVisibilityPrincipal,
} from "@infrawrench/server-core/cost/visibility";
import {
  runWithCostVisibility,
  type CostVisibility,
} from "@infrawrench/server-core/cost/visibility-context";
import { orgSubPath } from "./api-key-route-policy";

declare module "hono" {
  interface ContextVariableMap {
    costVisibility: CostVisibility;
  }
}

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

interface CostScopeDenyRule {
  prefix: string;
  methods: readonly string[] | "*";
  reason: string;
}

/**
 * Surfaces a cost-scoped principal is refused outright, because they are
 * org-wide by nature and cannot be meaningfully narrowed to a subset of rows.
 *
 * - Exports ship the whole billing history to a destination; a scoped export
 *   would be a second, unaudited copy of the scope's data on a schedule.
 * - Invoices and managed accounts freeze org-wide figures into documents sent
 *   to a third party; one approved by someone who sees a slice would be wrong.
 * - The weekly digest and org config documents are org-wide reports and
 *   configuration in one call.
 * - Role, membership and invitation changes, and editing scopes themselves:
 *   any of them could hand someone (including the caller's own second
 *   account) wider cost visibility than the caller holds, so a scoped
 *   principal cannot be the one making them.
 */
export const COST_SCOPE_DENY_RULES: readonly CostScopeDenyRule[] = [
  {
    prefix: "/cost-exports",
    methods: "*",
    reason:
      "Cost exports cover the whole organization and are not available with scoped cost access.",
  },
  {
    prefix: "/custom-cost-sources",
    methods: "*",
    reason:
      "Custom cost sources hold the whole organization's uploaded spend and are not available with scoped cost access.",
  },
  {
    prefix: "/invoices",
    methods: "*",
    reason:
      "Invoices use the whole organization's spend and are not available with scoped cost access.",
  },
  {
    prefix: "/managed-accounts",
    methods: "*",
    reason:
      "Managed accounts use the whole organization's spend and are not available with scoped cost access.",
  },
  {
    prefix: "/digest",
    methods: "*",
    reason:
      "The weekly digest reports org-wide spend and is not available with scoped cost access.",
  },
  {
    prefix: "/config",
    methods: "*",
    reason:
      "Org config documents cover every team's cost configuration and are not available with scoped cost access.",
  },
  {
    prefix: "/cost-visibility",
    methods: MUTATING,
    reason: "Members with scoped cost access cannot change cost visibility scopes.",
  },
  {
    prefix: "/team/roles",
    methods: MUTATING,
    reason:
      "Members with scoped cost access cannot change roles, which could widen someone's cost visibility.",
  },
  {
    prefix: "/team/invitations",
    methods: ["POST"],
    reason:
      "Members with scoped cost access cannot invite people, which could widen someone's cost visibility.",
  },
  {
    prefix: "/team/members",
    methods: ["PATCH", "PUT"],
    reason:
      "Members with scoped cost access cannot change roles, which could widen someone's cost visibility.",
  },
];

function matchesPrefix(subPath: string, prefix: string): boolean {
  return subPath === prefix || subPath.startsWith(`${prefix}/`);
}

/** The refusal for a scoped principal on this route, or null when allowed. */
export function costScopeRouteDenial(method: string, pathname: string): string | null {
  const subPath = orgSubPath(pathname);
  if (subPath === null) return null;
  const verb = method.toUpperCase();
  for (const rule of COST_SCOPE_DENY_RULES) {
    if (!matchesPrefix(subPath, rule.prefix)) continue;
    if (rule.methods === "*" || rule.methods.includes(verb)) return rule.reason;
  }
  return null;
}

/** The principal on a Hono context, in the shape the resolver takes. */
function contextPrincipal(c: Context): CostVisibilityPrincipal {
  const apiKey = c.get("apiKey") as
    { id: string; agentRegistrationId?: string | undefined } | undefined;
  return {
    userId: c.get("session").userId,
    apiKeyId: apiKey && !apiKey.agentRegistrationId ? apiKey.id : null,
    agentRegistrationId: apiKey?.agentRegistrationId ?? null,
  };
}

/**
 * Last in the org-tree chain: resolve, gate, then run the request inside the
 * caller's cost visibility. Fails closed: a resolution error is a 500, never
 * an unscoped request.
 */
export const costVisibilityMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  const organizationId = c.get("organizationId");
  const visibility = await resolveCostVisibility(organizationId, contextPrincipal(c));
  c.set("costVisibility", visibility);
  if (visibility.restricted) {
    const denial = costScopeRouteDenial(c.req.method, new URL(c.req.url).pathname);
    if (denial) return c.json({ error: denial, code: COST_SCOPE_RESTRICTED_CODE }, 403);
  }
  const sharing = await resolveSharingPrincipal(
    organizationId,
    c.get("session").userId,
    c.get("permissions") ?? [],
  );
  return runWithCostVisibility(visibility, () => runWithSharingPrincipal(sharing, next));
});

/** True when the request's caller is cost-scoped. */
export function requestIsCostScoped(c: Context): boolean {
  return c.get("costVisibility")?.restricted === true;
}

/**
 * The value to store in an object's `visibility_user_id` when the request's
 * caller creates it: the caller when scoped, null (org-wide) otherwise.
 */
export function visibilityUserIdForRequest(c: Context): string | null {
  return requestIsCostScoped(c) ? c.get("session").userId : null;
}

/**
 * Run `fn` inside a principal's cost visibility: the tool dispatcher, Slack
 * commands and any other surface that authenticates outside the org tree.
 */
export async function withPrincipalCostVisibility<T>(
  organizationId: string,
  principal: CostVisibilityPrincipal,
  fn: () => Promise<T>,
  permissions?: readonly string[],
): Promise<T> {
  const visibility = await resolveCostVisibility(organizationId, principal);
  if (!permissions) return await runWithCostVisibility(visibility, fn);
  // Tool calls also carry object sharing, like the HTTP tree does.
  const sharing = await resolveSharingPrincipal(organizationId, principal.userId, permissions);
  return await runWithCostVisibility(visibility, () => runWithSharingPrincipal(sharing, fn));
}
