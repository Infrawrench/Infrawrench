/**
 * Resolving who sees which cost rows: the database half of cost visibility.
 *
 * `visibility-context.ts` carries a resolved scope through an execution and
 * the ClickHouse readers apply it; this module turns a principal into that
 * scope. It is the cost-row counterpart of `permissions/resolver.ts` and is
 * called from the same places (the org-tree middleware, the tool dispatcher,
 * Slack commands) plus the unattended evaluators for objects a scoped member
 * created.
 *
 * Composition is intersection, never union: the role's scope, the member's own
 * scope and an API key's scope each narrow what the others allow. That is the
 * same rule that makes an API key's permissions its scopes ∩ its owner's role,
 * and it is what makes every layer safe to add without reasoning about the
 * others: a scope can only ever take rows away.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { CostFilter, CostVisibilitySource } from "@infrawrench/client-core";
import { db } from "../db/client";
import {
  agentAuthRegistrations,
  apiKeys,
  costVisibilityScopes,
  organizationMembers,
  roles,
  users,
} from "../db/schema";
import { listAllocationRules, listCostCentres } from "./allocation";
import { resolveSavedCostFilters, SavedCostFilterResolutionError } from "./saved-filters";
import {
  emptyCostVisibility,
  expandCentreSubtrees,
  unrestrictedCostVisibility,
  type CompiledCostVisibilityLayer,
  type CostVisibility,
} from "./visibility-context";

export interface CostVisibilityPrincipal {
  userId: string;
  /** Set when the request presented an `iwk_` key: its own scope applies too. */
  apiKeyId?: string | null | undefined;
  /**
   * Set for agent credentials. A claimed agent acts within its claimer's
   * scope (the same way its permissions are intersected with the claimer's
   * role); an unclaimed one lives in a trial org nobody can scope.
   */
  agentRegistrationId?: string | null | undefined;
}

export { expandCentreSubtrees };

type ScopeRow = typeof costVisibilityScopes.$inferSelect;

async function principalLabels(
  organizationId: string,
  rows: readonly ScopeRow[],
): Promise<Map<string, string | null>> {
  const ids = (kind: ScopeRow["principalKind"]) =>
    rows.filter((r) => r.principalKind === kind).map((r) => r.principalId);
  const roleIds = ids("role");
  const userIds = ids("member");
  const keyIds = ids("api_key");
  const [roleRows, userRows, keyRows] = await Promise.all([
    roleIds.length > 0
      ? db
          .select({ id: roles.id, label: roles.name })
          .from(roles)
          .where(and(eq(roles.organizationId, organizationId), inArray(roles.id, roleIds)))
      : Promise.resolve([]),
    userIds.length > 0
      ? db
          .select({ id: users.id, label: users.email })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    keyIds.length > 0
      ? db
          .select({ id: apiKeys.id, label: apiKeys.name })
          .from(apiKeys)
          .where(and(eq(apiKeys.organizationId, organizationId), inArray(apiKeys.id, keyIds)))
      : Promise.resolve([]),
  ]);
  const labels = new Map<string, string | null>();
  for (const r of roleRows) labels.set(`role:${r.id}`, r.label);
  for (const r of userRows) labels.set(`member:${r.id}`, r.label);
  for (const r of keyRows) labels.set(`api_key:${r.id}`, r.label);
  return labels;
}

/**
 * Compile stored scope rows into reader layers. Loads the org's centres and
 * allocation rules once, and only when some row names a centre.
 */
export async function compileCostVisibilityLayers(
  organizationId: string,
  rows: readonly ScopeRow[],
): Promise<CompiledCostVisibilityLayer[]> {
  const needsCentres = rows.some((r) => (r.costCentreIds ?? []).length > 0);
  const [centres, rules, labels] = await Promise.all([
    needsCentres ? listCostCentres(organizationId) : Promise.resolve([]),
    needsCentres ? listAllocationRules(organizationId) : Promise.resolve([]),
    principalLabels(organizationId, rows),
  ]);
  const liveCentres = new Set(centres.map((c) => c.id));
  const orderedRules = rules.flatMap((r) =>
    liveCentres.has(r.costCentreId) ? [{ costCentreId: r.costCentreId, match: r.match }] : [],
  );

  const layers: CompiledCostVisibilityLayer[] = [];
  for (const row of rows) {
    const costCentreIds = row.costCentreIds ?? [];
    const accountIds = row.accountIds ?? [];
    let filters: CostFilter[] | null = null;
    let unresolvable = false;
    if (row.savedFilterId) {
      try {
        filters = await resolveSavedCostFilters(organizationId, row.savedFilterId);
      } catch (err) {
        // A filter that no longer resolves makes the layer match nothing.
        // Dropping it would widen the scope to everything the accounts and
        // centres allow, which is exactly the failure a scope exists to stop.
        if (!(err instanceof SavedCostFilterResolutionError)) throw err;
        unresolvable = true;
      }
    }
    const source: CostVisibilitySource = {
      kind: row.principalKind,
      label: labels.get(`${row.principalKind}:${row.principalId}`) ?? null,
      costCentreIds: [...costCentreIds],
      accountIds: [...accountIds],
      savedFilterId: row.savedFilterId ?? null,
    };
    const expanded = expandCentreSubtrees(costCentreIds, centres);
    layers.push({
      source,
      accountIds: [...accountIds],
      costCentreIds: expanded,
      rules: expanded.length > 0 ? orderedRules : [],
      filters,
      unresolvable,
    });
  }
  return layers;
}

/**
 * The cost visibility `principal` has in `organizationId`.
 *
 * - No membership: matches nothing. A removed member's key is revoked anyway,
 *   but an object evaluating "as" a departed user must see no rows rather than
 *   fall back to the whole org.
 * - Owner: role and member scopes are ignored (owners are never scoped, and
 *   an owner locked out of the org's spend is not recoverable from the UI). An
 *   API key an owner minted still honours its own key scope.
 * - Otherwise: every applicable scope row, intersected.
 */
export async function resolveCostVisibility(
  organizationId: string,
  principal: CostVisibilityPrincipal,
): Promise<CostVisibility> {
  let userId = principal.userId;
  let apiKeyId = principal.apiKeyId ?? null;

  if (principal.agentRegistrationId) {
    const [reg] = await db
      .select({ claimedByUserId: agentAuthRegistrations.claimedByUserId })
      .from(agentAuthRegistrations)
      .where(eq(agentAuthRegistrations.id, principal.agentRegistrationId))
      .limit(1);
    // Unclaimed: a trial org with no people in it, so nothing can be scoped.
    if (!reg?.claimedByUserId) return unrestrictedCostVisibility(organizationId);
    userId = reg.claimedByUserId;
    apiKeyId = null;
  }

  const [member] = await db
    .select({
      roleId: organizationMembers.roleId,
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
    })
    .from(organizationMembers)
    .leftJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!member) return emptyCostVisibility(organizationId, userId);

  const isOwner = member.roleId ? member.systemKey === "owner" : member.legacyRole === "owner";

  const principalConds = [];
  if (!isOwner) {
    principalConds.push(
      and(
        eq(costVisibilityScopes.principalKind, "member"),
        eq(costVisibilityScopes.principalId, userId),
      ),
    );
    if (member.roleId) {
      principalConds.push(
        and(
          eq(costVisibilityScopes.principalKind, "role"),
          eq(costVisibilityScopes.principalId, member.roleId),
        ),
      );
    }
  }
  if (apiKeyId) {
    principalConds.push(
      and(
        eq(costVisibilityScopes.principalKind, "api_key"),
        eq(costVisibilityScopes.principalId, apiKeyId),
      ),
    );
  }
  if (principalConds.length === 0) return unrestrictedCostVisibility(organizationId);

  const rows = await db
    .select()
    .from(costVisibilityScopes)
    .where(and(eq(costVisibilityScopes.organizationId, organizationId), or(...principalConds)));
  if (rows.length === 0) return unrestrictedCostVisibility(organizationId);

  // Role first, then member, then key: the order `/team/me` lists them in.
  const order = { role: 0, member: 1, api_key: 2 } as const;
  rows.sort((a, b) => order[a.principalKind] - order[b.principalKind]);
  return {
    organizationId,
    restricted: true,
    userId,
    layers: await compileCostVisibilityLayers(organizationId, rows),
  };
}

/**
 * The visibility an unattended evaluator applies to an object a scoped member
 * created (`visibility_user_id`), or unrestricted when the column is null.
 */
export async function resolveObjectCostVisibility(
  organizationId: string,
  visibilityUserId: string | null | undefined,
): Promise<CostVisibility> {
  if (!visibilityUserId) return unrestrictedCostVisibility(organizationId);
  return await resolveCostVisibility(organizationId, { userId: visibilityUserId });
}
