/**
 * Cost visibility scopes: `/api/org/:orgId/cost-visibility`, the handlers.
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
import { randomUUID } from "node:crypto";
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  COST_VISIBILITY_LIMITS,
  COST_VISIBILITY_PRINCIPAL_KINDS,
  type CostVisibilityPrincipalKind,
  type CostVisibilityScope as CostVisibilityScopeValue,
  type CostVisibilityScopeInput as CostVisibilityScopeInputValue,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { listCostCentres } from "@infrawrench/server-core/cost/allocation";
import {
  resolveSavedCostFilters,
  SavedCostFilterResolutionError,
} from "@infrawrench/server-core/cost/saved-filters";
import { db } from "../../../db/client";
import {
  accounts,
  apiKeys,
  costVisibilityScopes,
  organizationMembers,
  roles,
  users,
} from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, Forbidden, NotFound, notFound } from "../../errors";
import { readJsonOr } from "../../json-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { CostVisibilityApi, CostVisibilityScope } from "./api";

type ScopeRow = typeof costVisibilityScopes.$inferSelect;

async function labelRows(
  organizationId: string,
  rows: ScopeRow[],
): Promise<CostVisibilityScopeValue[]> {
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

/** A refusal with the status the route answered it with. */
class ScopeInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

const scopeRefusal = (error: unknown): BadRequest | Forbidden | NotFound | undefined => {
  if (!(error instanceof ScopeInputError)) return undefined;
  switch (error.status) {
    case 403:
      return new Forbidden({ error: error.message });
    case 404:
      return new NotFound({ error: error.message });
    default:
      return new BadRequest({ error: error.message });
  }
};

const isPrincipalKind = (value: unknown): value is CostVisibilityPrincipalKind =>
  COST_VISIBILITY_PRINCIPAL_KINDS.some((kind) => kind === value);

/** A property of a parsed JSON value: what `(value as Record)[key]` read. */
const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined;

/** The body, checked field by field with the sentences it always had. */
const parseInput = Effect.fnUntraced(function* (raw: unknown) {
  if (!Predicate.isObjectOrArray(raw)) return yield* badRequest("Expected a JSON object.");
  const kind = field(raw, "principalKind");
  if (!isPrincipalKind(kind)) {
    return yield* badRequest("principalKind must be role, member or api_key.");
  }
  const principalId = field(raw, "principalId");
  if (!Predicate.isString(principalId) || principalId.length === 0) {
    return yield* badRequest("principalId is required.");
  }
  const strings = Effect.fnUntraced(function* (key: string, max: number) {
    const v = field(raw, key) ?? [];
    if (!Array.isArray(v)) return yield* badRequest(`${key} must be a list of ids.`);
    const ids: string[] = [];
    for (const x of v) {
      if (!Predicate.isString(x) || x.length === 0) {
        return yield* badRequest(`${key} must be a list of ids.`);
      }
      ids.push(x);
    }
    const unique = [...new Set(ids)];
    if (unique.length > max) return yield* badRequest(`${key} may name at most ${max} items.`);
    return unique;
  });
  const savedFilterId = field(raw, "savedFilterId") ?? null;
  if (
    savedFilterId !== null &&
    (!Predicate.isString(savedFilterId) || savedFilterId.length === 0)
  ) {
    return yield* badRequest("savedFilterId must be a saved filter id or null.");
  }
  const input: CostVisibilityScopeInputValue = {
    principalKind: kind,
    principalId,
    costCentreIds: yield* strings("costCentreIds", COST_VISIBILITY_LIMITS.maxCostCentres),
    accountIds: yield* strings("accountIds", COST_VISIBILITY_LIMITS.maxAccounts),
    savedFilterId,
  };
  return input;
});

interface Caller {
  readonly organizationId: string;
  readonly userId: string;
  readonly permissions: readonly string[];
}

/**
 * Who may change the scope of this principal. Roles and members need
 * `team:role:write`; an API key's own owner may also set its scope with
 * `apikeys:write`. Owners (and the owner role) are never scoped.
 */
async function assertCanManage(
  caller: Caller,
  kind: CostVisibilityPrincipalKind,
  principalId: string,
): Promise<void> {
  const { organizationId, permissions: perms } = caller;
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
  const ownKey = key.userId === caller.userId && hasPermission(perms, "apikeys:write");
  if (!canTeam && !ownKey) {
    throw new ScopeInputError(
      "Missing permission: team:role:write (or apikeys:write on your own key)",
      403,
    );
  }
}

/** Every referenced id must exist in the org now (later deletion just narrows). */
async function assertReferences(organizationId: string, input: CostVisibilityScopeInputValue) {
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

/** Check, then create or replace the scope of one principal. */
async function upsertScope(
  caller: Caller,
  input: CostVisibilityScopeInputValue,
): Promise<ScopeRow> {
  const { organizationId } = caller;
  await assertCanManage(caller, input.principalKind, input.principalId);
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
      createdByUserId: caller.userId,
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
  return row!;
}

/** Check, then lift a scope; the deleted row's id, or null when there was none. */
async function removeScope(
  caller: Caller,
  kind: CostVisibilityPrincipalKind,
  principalId: string,
): Promise<string | null> {
  // A revoked key's or departed member's leftover scope is still removable.
  if (!hasPermission(caller.permissions, "team:role:write")) {
    await assertCanManage(caller, kind, principalId);
  }
  const deleted = await db
    .delete(costVisibilityScopes)
    .where(
      and(
        eq(costVisibilityScopes.organizationId, caller.organizationId),
        eq(costVisibilityScopes.principalKind, kind),
        eq(costVisibilityScopes.principalId, principalId),
      ),
    )
    .returning({ id: costVisibilityScopes.id });
  return deleted[0]?.id ?? null;
}

const ScopeList = Schema.Struct({ scopes: Schema.Array(CostVisibilityScope) });

const currentCaller = Effect.gen(function* () {
  const { organizationId, session, permissions } = yield* OrgPrincipal;
  const caller: Caller = { organizationId, userId: session.userId, permissions };
  return caller;
});

const CostVisibilityHandlers = HttpApiBuilder.group(
  CostVisibilityApi,
  "costVisibility",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const scopes = yield* legacy(async () => {
            const rows = await db
              .select()
              .from(costVisibilityScopes)
              .where(eq(costVisibilityScopes.organizationId, organizationId))
              .orderBy(costVisibilityScopes.principalKind, costVisibilityScopes.createdAt);
            return labelRows(organizationId, rows);
          });
          return yield* respond(ScopeList)({ scopes });
        }),
      )
      .handleRaw("upsert", ({ request }) =>
        Effect.gen(function* () {
          const caller = yield* currentCaller;
          const input = yield* parseInput(yield* readJsonOr(request, null));
          const row = yield* legacyTry(() => upsertScope(caller, input), scopeRefusal);
          yield* fireAndForget(() =>
            logAudit({
              organizationId: caller.organizationId,
              userId: caller.userId,
              action: "cost_visibility.update",
              entityType: "cost_visibility_scope",
              entityId: row.id,
              metadata: {
                principalKind: input.principalKind,
                principalId: input.principalId,
                costCentres: input.costCentreIds.length,
                accounts: input.accountIds.length,
                savedFilterId: input.savedFilterId,
              },
            }),
          );
          const [labelled] = yield* legacy(() => labelRows(caller.organizationId, [row]));
          return yield* respond(CostVisibilityScope)(labelled);
        }),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          const caller = yield* currentCaller;
          const kind = params.principalKind;
          if (!isPrincipalKind(kind)) {
            return yield* badRequest("principalKind must be role, member or api_key.");
          }
          const deletedId = yield* legacyTry(
            () => removeScope(caller, kind, params.principalId),
            scopeRefusal,
          );
          if (deletedId === null) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId: caller.organizationId,
              userId: caller.userId,
              action: "cost_visibility.delete",
              entityType: "cost_visibility_scope",
              entityId: deletedId,
              metadata: { principalKind: kind, principalId: params.principalId },
            }),
          );
          return ok;
        }),
      ),
);

export const costVisibilityDomain = makeDomain(
  "cost-visibility",
  CostVisibilityApi,
  CostVisibilityHandlers,
);
