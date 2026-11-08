/**
 * Cost visibility on the HTTP and tool surfaces.
 *
 * The scope itself is applied by the ClickHouse readers (server-core
 * `cost/visibility-context.ts`); this module is what *establishes* it outside
 * the org tree, and lists what a scoped caller is refused there. On the org
 * tree, `OrgAuth` (`http/middleware-live.ts`) resolves the caller's scope once
 * the principal and its permissions are known, refuses the handful of
 * org-wide surfaces in {@link COST_SCOPE_DENY_RULES}, and runs the handler
 * inside the scope. Tool dispatch (chat, MCP) and Slack commands call
 * {@link withPrincipalCostVisibility} for the same effect outside it.
 */
import { resolveSharingPrincipal, runWithSharingPrincipal } from "../services/object-sharing";
import {
  resolveCostVisibility,
  type CostVisibilityPrincipal,
} from "@infrawrench/server-core/cost/visibility";
import { runWithCostVisibility } from "@infrawrench/server-core/cost/visibility-context";
import { orgSubPath } from "./api-key-route-policy";

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
    prefix: "/billing-profiles",
    methods: "*",
    reason:
      "Billing profiles belong to the invoicing surface, which uses the whole organization's spend and is not available with scoped cost access.",
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
