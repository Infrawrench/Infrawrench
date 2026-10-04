/**
 * Cost visibility scopes (`/api/org/:orgId/cost-visibility`).
 *
 * A scope narrows which cost rows a role, a member or an API key can see (see
 * `client-core/src/cost-visibility.ts` for the model and
 * `server-core/src/cost/visibility.ts` for resolution). Listing is
 * `team:read`, like roles. Changing a role or member scope is
 * `team:role:write`: a scope is part of what a role grants, and the same
 * people who decide roles decide it. An API key's scope may also be set by the
 * key's own owner with `apikeys:write`, since a key scope can only ever narrow
 * its owner.
 *
 * Cost-scoped callers are refused every write here by the org-tree middleware
 * (`COST_SCOPE_DENY_RULES`): a scoped person editing scopes could lift their
 * own restriction.
 */
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  COST_VISIBILITY_LIMITS,
  COST_VISIBILITY_PRINCIPAL_KINDS,
  type CostVisibilityPrincipalKind,
  type CostVisibilityScope,
  type CostVisibilityScopeInput,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { listCostCentres } from "@infrawrench/server-core/cost/allocation";
import {
  resolveSavedCostFilters,
  SavedCostFilterResolutionError,
} from "@infrawrench/server-core/cost/saved-filters";
import { db } from "../../db/client";
import {
  accounts,
  apiKeys,
  costVisibilityScopes,
  organizationMembers,
  roles,
  users,
} from "../../db/schema";
import { logAudit } from "../../services/audit";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
  }
}

const app = new Hono();

type ScopeRow = typeof costVisibilityScopes.$inferSelect;

async function labelRows(organizationId: string, rows: ScopeRow[]): Promise<CostVisibilityScope[]> {
  const ids = (kind: CostVisibilityPrincipalKind) =>
    rows.filter((r) => r.principalKind === kind).map((r) => r.principalId);
  const [roleRows, userRows, keyRows] = await Promise.all([
    ids("role").length > 0
      ? db
          .select({ id: roles.id, label: roles.name })
          .from(roles)
          .where(and(eq(roles.organizationId, organizationId), inArray(roles.id, ids("role"))))
      : Promise.resolve([]),
    ids("member").length > 0
      ? db
          .select({ id: users.id, label: users.email })
          .from(users)
          .where(inArray(users.id, ids("member")))
      : Promise.resolve([]),
    ids("api_key").length > 0
      ? db
          .select({ id: apiKeys.id, label: apiKeys.name })
          .from(apiKeys)
          .where(
            and(eq(apiKeys.organizationId, organizationId), inArray(apiKeys.id, ids("api_key"))),
          )
      : Promise.resolve([]),
  ]);
  const labels = new Map<string, string>();
  for (const r of roleRows) labels.set(`role:${r.id}`, r.label);
  for (const r of userRows) labels.set(`member:${r.id}`, r.label);
  for (const r of keyRows) labels.set(`api_key:${r.id}`, r.label);
  return rows.map((r) => ({
    id: r.id,
    principalKind: r.principalKind,
    principalId: r.principalId,
    principalLabel: labels.get(`${r.principalKind}:${r.principalId}`) ?? null,
    costCentreIds: r.costCentreIds ?? [],
    accountIds: r.accountIds ?? [],
    savedFilterId: r.savedFilterId ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

class ScopeInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

function parseInput(raw: unknown): CostVisibilityScopeInput {
  if (!raw || typeof raw !== "object") throw new ScopeInputError("Expected a JSON object.");
  const body = raw as Record<string, unknown>;
  const kind = body["principalKind"];
  if (!COST_VISIBILITY_PRINCIPAL_KINDS.includes(kind as CostVisibilityPrincipalKind)) {
    throw new ScopeInputError("principalKind must be role, member or api_key.");
  }
  const principalId = body["principalId"];
  if (typeof principalId !== "string" || principalId.length === 0) {
    throw new ScopeInputError("principalId is required.");
  }
  const strings = (key: string, max: number): string[] => {
    const v = body[key] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0)) {
      throw new ScopeInputError(`${key} must be a list of ids.`);
    }
    const unique = [...new Set(v as string[])];
    if (unique.length > max) throw new ScopeInputError(`${key} may name at most ${max} items.`);
    return unique;
  };
  const savedFilterId = body["savedFilterId"] ?? null;
  if (savedFilterId !== null && (typeof savedFilterId !== "string" || savedFilterId.length === 0)) {
    throw new ScopeInputError("savedFilterId must be a saved filter id or null.");
  }
  return {
    principalKind: kind as CostVisibilityPrincipalKind,
    principalId,
    costCentreIds: strings("costCentreIds", COST_VISIBILITY_LIMITS.maxCostCentres),
    accountIds: strings("accountIds", COST_VISIBILITY_LIMITS.maxAccounts),
    savedFilterId: savedFilterId as string | null,
  };
}

/**
 * Who may change the scope of this principal. Roles and members need
 * `team:role:write`; an API key's own owner may also set its scope with
 * `apikeys:write`. Owners (and the owner role) are never scoped.
 */
async function assertCanManage(
  c: Context,
  organizationId: string,
  kind: CostVisibilityPrincipalKind,
  principalId: string,
): Promise<void> {
  const perms = c.get("permissions") ?? [];
  const canTeam = hasPermission(perms, "team:role:write");
  if (kind === "role") {
    if (!canTeam) throw new ScopeInputError("Missing permission: team:role:write", 403);
    const [role] = await db
      .select({ systemKey: roles.systemKey })
      .from(roles)
      .where(and(eq(roles.id, principalId), eq(roles.organizationId, organizationId)))
      .limit(1);
    if (!role) throw new ScopeInputError("Role not found.", 404);
    if (role.systemKey === "owner") {
      throw new ScopeInputError("The Owner role always sees all costs and cannot be scoped.");
    }
    return;
  }
  if (kind === "member") {
    if (!canTeam) throw new ScopeInputError("Missing permission: team:role:write", 403);
    const [member] = await db
      .select({ legacyRole: organizationMembers.role, systemKey: roles.systemKey })
      .from(organizationMembers)
      .leftJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, principalId),
        ),
      )
      .limit(1);
    if (!member) throw new ScopeInputError("Member not found.", 404);
    if ((member.systemKey ?? member.legacyRole) === "owner") {
      throw new ScopeInputError("Owners always see all costs and cannot be scoped.");
    }
    return;
  }
  const [key] = await db
    .select({ userId: apiKeys.userId })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, principalId),
        eq(apiKeys.organizationId, organizationId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);
  if (!key) throw new ScopeInputError("API key not found.", 404);
  const ownKey = key.userId === c.get("session").userId && hasPermission(perms, "apikeys:write");
  if (!canTeam && !ownKey) {
    throw new ScopeInputError(
      "Missing permission: team:role:write (or apikeys:write on your own key)",
      403,
    );
  }
}

/** Every referenced id must exist in the org now (later deletion just narrows). */
async function assertReferences(organizationId: string, input: CostVisibilityScopeInput) {
  if (input.costCentreIds.length > 0) {
    const centres = new Set((await listCostCentres(organizationId)).map((c) => c.id));
    if (input.costCentreIds.some((id) => !centres.has(id))) {
      throw new ScopeInputError("One of the cost centres does not exist in this organization.");
    }
  }
  if (input.accountIds.length > 0) {
    const found = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organizationId),
          inArray(accounts.id, input.accountIds),
          isNull(accounts.deletedAt),
        ),
      );
    if (found.length !== input.accountIds.length) {
      throw new ScopeInputError("One of the accounts is not connected to this organization.");
    }
  }
  if (input.savedFilterId) {
    try {
      await resolveSavedCostFilters(organizationId, input.savedFilterId);
    } catch (e) {
      if (e instanceof SavedCostFilterResolutionError) {
        throw new ScopeInputError("The saved filter does not exist in this organization.");
      }
      throw e;
    }
  }
}

/** GET /cost-visibility: every scope in the org. */
app.get("/", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  const rows = await db
    .select()
    .from(costVisibilityScopes)
    .where(eq(costVisibilityScopes.organizationId, organizationId))
    .orderBy(costVisibilityScopes.principalKind, costVisibilityScopes.createdAt);
  return c.json({ scopes: await labelRows(organizationId, rows) });
});

/** PUT /cost-visibility: create or replace the scope of one principal. */
app.put("/", async (c) => {
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const input = parseInput(await c.req.json().catch(() => null));
    await assertCanManage(c, organizationId, input.principalKind, input.principalId);
    await assertReferences(organizationId, input);
    const now = new Date();
    const [row] = await db
      .insert(costVisibilityScopes)
      .values({
        id: randomUUID(),
        organizationId,
        principalKind: input.principalKind,
        principalId: input.principalId,
        costCentreIds: input.costCentreIds,
        accountIds: input.accountIds,
        savedFilterId: input.savedFilterId,
        createdByUserId: session.userId,
      })
      .onConflictDoUpdate({
        target: [
          costVisibilityScopes.organizationId,
          costVisibilityScopes.principalKind,
          costVisibilityScopes.principalId,
        ],
        set: {
          costCentreIds: input.costCentreIds,
          accountIds: input.accountIds,
          savedFilterId: input.savedFilterId,
          updatedAt: now,
        },
      })
      .returning();
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_visibility.update",
      entityType: "cost_visibility_scope",
      entityId: row!.id,
      metadata: {
        principalKind: input.principalKind,
        principalId: input.principalId,
        costCentres: input.costCentreIds.length,
        accounts: input.accountIds.length,
        savedFilterId: input.savedFilterId,
      },
    });
    const [labelled] = await labelRows(organizationId, [row!]);
    return c.json(labelled);
  } catch (e) {
    if (e instanceof ScopeInputError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

/** DELETE /cost-visibility/:principalKind/:principalId: lift a scope. */
app.delete("/:principalKind/:principalId", async (c) => {
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const kind = c.req.param("principalKind") as CostVisibilityPrincipalKind;
  const principalId = c.req.param("principalId");
  if (!COST_VISIBILITY_PRINCIPAL_KINDS.includes(kind)) {
    return c.json({ error: "principalKind must be role, member or api_key." }, 400);
  }
  try {
    // A revoked key's or departed member's leftover scope is still removable.
    const perms = c.get("permissions") ?? [];
    if (!hasPermission(perms, "team:role:write")) {
      await assertCanManage(c, organizationId, kind, principalId);
    }
    const deleted = await db
      .delete(costVisibilityScopes)
      .where(
        and(
          eq(costVisibilityScopes.organizationId, organizationId),
          eq(costVisibilityScopes.principalKind, kind),
          eq(costVisibilityScopes.principalId, principalId),
        ),
      )
      .returning({ id: costVisibilityScopes.id });
    if (deleted.length === 0) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_visibility.delete",
      entityType: "cost_visibility_scope",
      entityId: deleted[0]!.id,
      metadata: { principalKind: kind, principalId },
    });
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof ScopeInputError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

export { app as costVisibilityRoutes };
