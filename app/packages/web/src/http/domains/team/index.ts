/**
 * Team: `/api/org/:orgId/team`, the handlers.
 *
 * Every mutation that hands out authority is guarded twice over: a role or
 * invitation may not grant a permission the caller lacks (the escalation
 * guard), and only an owner may make, unmake or remove an owner (the owner
 * guards), with the last human owner never removable. Agents never count as
 * owners, and `AGENT_DENY_RULES` keeps them off invitations entirely.
 */
import { randomBytes, createHash } from "node:crypto";
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { v4 as uuid } from "uuid";
import { eq, and, isNull, sql } from "drizzle-orm";
import {
  ALL_PERMISSIONS,
  ensureSystemRoles,
  getSystemRole,
  isSubsetOfCallerPerms,
  isSystemRoleKey,
  systemRolePermissions,
} from "@infrawrench/server-core/permissions";
import { isAgentUserId } from "@infrawrench/server-core/trials/identity";
import { summarizeCostVisibility } from "@infrawrench/server-core/cost/visibility-context";
import { db } from "../../../db/client";
import {
  apiKeys,
  costVisibilityScopes,
  users,
  invitations,
  organizationMembers,
  roles,
} from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { addSeat, checkSeatAvailability, releaseSeat } from "../../../services/seats";
import { planAccess, FREE_PLAN_LIMITS, type PlanAccess } from "../../../services/entitlements";
import { isOwnerRole } from "../../../services/org-roles";
import { makeDomain } from "../../domain";
import {
  BadRequest,
  badRequest,
  conflict,
  forbidden,
  notFound,
  PaymentRequired,
} from "../../errors";
import { fieldsOf, readJson } from "../../request-body";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  Invitation,
  InviteResponse,
  MeResponse,
  OrgMember,
  PermissionCatalog,
  Role,
  SeatLimitReached,
  SeatPurchaseFailed,
  TeamApi,
  Unprocessable,
} from "./api";

type RoleRow = typeof roles.$inferSelect;

function serializeRole(row: RoleRow) {
  const permissions =
    row.isSystem && isSystemRoleKey(row.systemKey)
      ? [...(systemRolePermissions(row.systemKey) ?? [])]
      : (row.permissions ?? []);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    systemKey: row.systemKey,
    permissions,
  };
}

/** The permissions a role row grants: a system role's from the catalog, a custom role's stored. */
function rolePermissions(row: RoleRow): readonly string[] {
  return row.isSystem && isSystemRoleKey(row.systemKey)
    ? (systemRolePermissions(row.systemKey) ?? [])
    : (row.permissions ?? []);
}

const findRole = (organizationId: string, roleId: string) =>
  legacy(() =>
    db
      .select()
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
      .limit(1),
  ).pipe(Effect.map(([row]) => row));

/**
 * The fields the role and membership handlers can use from a body. A field of
 * the wrong JSON type used to throw on `.trim()` or reach Postgres; it is a
 * 400 now. Everything else is still checked by hand, with the routes' own
 * sentences.
 */
const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const RoleCreateBody = Schema.Struct({
  name: Schema.optionalKey(Schema.Unknown),
  description: OptionalText,
  permissions: Schema.optionalKey(Schema.Unknown),
});
const InviteBody = Schema.Struct({
  email: Schema.String,
  role: OptionalText,
  roleId: OptionalText,
  addSeat: Schema.optionalKey(Schema.Unknown),
});
const RoleChangeBody = Schema.Struct({ role: OptionalText, roleId: OptionalText });

const decodeBody = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown, error: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new BadRequest({ error })));

/** Only the strings of a permissions list; anything that is not a list grants nothing. */
const permissionStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(Predicate.isString) : [];

/**
 * The usual invitation lifetime, clamped so it never outlives a trial org.
 *
 * The clamp is defensive rather than reachable today: agents may not invite
 * (`AGENT_DENY_RULES` closes `POST /team/invitations`), and no human is a
 * member of an org while it is still a trial, so no invite is ever minted from
 * one. It stays because invitations cascade with the organization: an invite
 * whose link outlives the org would be a dead link with no explanation.
 */
function inviteExpiry(access: PlanAccess): Date {
  const standard = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const trialEnd = access.trialExpiresAt;
  if (!trialEnd) return standard;
  return trialEnd < standard ? trialEnd : standard;
}

// Counts both new (role.systemKey === "owner") and legacy (text role) owners,
// for the "last owner" guard on member delete and role change.
//
// Agent memberships never count, whatever role their row carries: the guard
// exists so a *person* always remains who can administer the org, and an agent
// cannot. A claimed org whose agent still counted as an owner would let the
// only human owner remove themselves.
async function countOwners(organizationId: string): Promise<number> {
  const rows = await db
    .select({
      userId: organizationMembers.userId,
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
    })
    .from(organizationMembers)
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(eq(organizationMembers.organizationId, organizationId));
  let count = 0;
  for (const r of rows) {
    if (isAgentUserId(r.userId)) continue;
    if (isOwnerRole(r.systemKey, r.legacyRole)) count++;
  }
  return count;
}

/** True if the membership row for (userId, orgId) is an owner. */
async function isMemberOwner(organizationId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ legacyRole: organizationMembers.role, systemKey: roles.systemKey })
    .from(organizationMembers)
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) return false;
  return isOwnerRole(row.systemKey, row.legacyRole);
}

async function countRows(query: Promise<Array<{ n: number }>>): Promise<number> {
  const [row] = await query;
  return row?.n ?? 0;
}

/**
 * Delete a custom role nobody holds, with its cost visibility scope (no member
 * holds the role, as checked before, so this narrows nobody's access).
 */
async function deleteRoleRows(organizationId: string, roleId: string) {
  await db.delete(roles).where(eq(roles.id, roleId));
  await db
    .delete(costVisibilityScopes)
    .where(
      and(
        eq(costVisibilityScopes.organizationId, organizationId),
        eq(costVisibilityScopes.principalKind, "role"),
        eq(costVisibilityScopes.principalId, roleId),
      ),
    );
}

/**
 * Remove a membership, its member-level cost visibility scope (a later
 * re-invite starts from whatever the new role says) and revoke the keys they
 * minted here. The auth chain re-checks membership, so the revocation is
 * belt-and-braces, but it leaves an accurate record, and the removed user can
 * no longer reach the UI to revoke them. Returns the revoked key ids.
 */
async function removeMembership(organizationId: string, userId: string) {
  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    );
  await db
    .delete(costVisibilityScopes)
    .where(
      and(
        eq(costVisibilityScopes.organizationId, organizationId),
        eq(costVisibilityScopes.principalKind, "member"),
        eq(costVisibilityScopes.principalId, userId),
      ),
    );
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.organizationId, organizationId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  return revoked.map((k) => k.id);
}

/** A role a member or invitation would carry, resolved from `roleId` or a system role name. */
interface TargetRole {
  readonly id: string | null;
  readonly legacyRole: string;
  readonly permissions: readonly string[];
}

const TeamHandlers = HttpApiBuilder.group(TeamApi, "team", (handlers) =>
  handlers
    .handle("me", () =>
      Effect.gen(function* () {
        const { session, role, permissions, elevations, costVisibility } = yield* OrgPrincipal;
        return yield* respond(MeResponse)({
          userId: session.userId,
          email: session.email,
          role: role
            ? {
                id: role.id,
                name: role.name,
                description: role.description,
                isSystem: role.isSystem,
                systemKey: role.systemKey,
              }
            : null,
          permissions: [...permissions],
          // Live break-glass grants, already included in `permissions`, listed
          // so the app can show what is temporary and when it lapses.
          elevations: [...elevations],
          // Informational: every cost read enforces it server-side.
          costVisibility: summarizeCostVisibility(costVisibility),
        });
      }),
    )
    .handle("permissions", () => respond(PermissionCatalog)({ permissions: [...ALL_PERMISSIONS] }))
    .handle("listRoles", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(async () => {
          await ensureSystemRoles(organizationId);
          return db.select().from(roles).where(eq(roles.organizationId, organizationId));
        });
        return yield* respond(Schema.Array(Role))(rows.map(serializeRole));
      }),
    )
    .handleRaw("createRole", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session, permissions: callerPerms } = yield* OrgPrincipal;
        const body = yield* decodeBody(
          RoleCreateBody,
          yield* fieldsOf(yield* readJson(request)),
          "Invalid role",
        );
        const name = Predicate.isString(body.name) ? body.name.trim() : "";
        if (!name) return yield* badRequest("Name is required");
        const cleanPerms = permissionStrings(body.permissions);
        // Privilege-escalation guard: caller cannot grant permissions they don't hold.
        if (!isSubsetOfCallerPerms(cleanPerms, callerPerms)) {
          return yield* forbidden("Cannot grant permissions you do not hold yourself");
        }
        const id = uuid();
        yield* legacy(() =>
          db.insert(roles).values({
            id,
            organizationId,
            name,
            description: body.description?.trim() || null,
            isSystem: false,
            systemKey: null,
            permissions: cleanPerms,
          }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "role.create",
            entityType: "role",
            entityId: id,
            metadata: { name, permissions: cleanPerms },
          }),
        );
        const [row] = yield* legacy(() => db.select().from(roles).where(eq(roles.id, id)));
        return yield* respond(Role)(
          row ? serializeRole(row) : { id, name, permissions: cleanPerms },
        );
      }),
    )
    .handleRaw("updateRole", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session, permissions: callerPerms } = yield* OrgPrincipal;
        const roleId = params.id;
        const { name, description, permissions } = yield* fieldsOf(yield* readJson(request));

        const existing = yield* findRole(organizationId, roleId);
        if (!existing) return yield* notFound("Role not found");
        if (existing.isSystem) {
          return yield* new Unprocessable({ error: "System roles cannot be edited" });
        }

        const updates: Partial<typeof roles.$inferInsert> = { updatedAt: new Date() };
        if (Predicate.isString(name) && name.trim()) updates.name = name.trim();
        if (description !== undefined) {
          updates.description = description === null ? null : String(description).trim() || null;
        }
        if (Array.isArray(permissions)) {
          const cleanPerms = permissionStrings(permissions);
          // Privilege-escalation guard: caller cannot grant permissions they don't hold.
          if (!isSubsetOfCallerPerms(cleanPerms, callerPerms)) {
            return yield* forbidden("Cannot grant permissions you do not hold yourself");
          }
          updates.permissions = cleanPerms;
        }

        yield* legacy(() => db.update(roles).set(updates).where(eq(roles.id, roleId)));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "role.update",
            entityType: "role",
            entityId: roleId,
            metadata: { updates },
          }),
        );
        const [row] = yield* legacy(() => db.select().from(roles).where(eq(roles.id, roleId)));
        return yield* respond(Role)(row ? serializeRole(row) : ok);
      }),
    )
    .handle("deleteRole", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const roleId = params.id;
        const existing = yield* findRole(organizationId, roleId);
        if (!existing) return yield* notFound("Role not found");
        if (existing.isSystem) {
          return yield* new Unprocessable({ error: "System roles cannot be deleted" });
        }

        // Reject if any member or pending invitation still references the role.
        const members = yield* legacy(() =>
          countRows(
            db
              .select({ n: sql<number>`count(*)` })
              .from(organizationMembers)
              .where(eq(organizationMembers.roleId, roleId)),
          ),
        );
        if (members > 0) {
          return yield* conflict(
            "Role is assigned to one or more members. Reassign them before deleting.",
          );
        }
        const pendingInvites = yield* legacy(() =>
          countRows(
            db
              .select({ n: sql<number>`count(*)` })
              .from(invitations)
              .where(and(eq(invitations.roleId, roleId), isNull(invitations.acceptedAt))),
          ),
        );
        if (pendingInvites > 0) {
          return yield* conflict(
            "Role is referenced by pending invitations. Cancel them before deleting.",
          );
        }

        yield* legacy(() => deleteRoleRows(organizationId, roleId));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "role.delete",
            entityType: "role",
            entityId: roleId,
          }),
        );
        return ok;
      }),
    )
    .handle("listMembers", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() =>
          db
            .select({
              id: users.id,
              email: users.email,
              displayName: users.displayName,
              role: organizationMembers.role,
              roleId: organizationMembers.roleId,
              roleName: roles.name,
              roleSystemKey: roles.systemKey,
              createdAt: organizationMembers.createdAt,
            })
            .from(organizationMembers)
            .innerJoin(users, eq(organizationMembers.userId, users.id))
            .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
            .where(eq(organizationMembers.organizationId, organizationId)),
        );
        return yield* respond(Schema.Array(OrgMember))(rows);
      }),
    )
    .handle("listInvitations", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() =>
          db
            .select({
              id: invitations.id,
              email: invitations.email,
              role: invitations.role,
              roleId: invitations.roleId,
              roleName: roles.name,
              acceptedAt: invitations.acceptedAt,
              expiresAt: invitations.expiresAt,
              createdAt: invitations.createdAt,
            })
            .from(invitations)
            .leftJoin(roles, eq(invitations.roleId, roles.id))
            .where(eq(invitations.organizationId, organizationId)),
        );
        return yield* respond(Schema.Array(Invitation))(rows);
      }),
    )
    .handleRaw("invite", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session, permissions: callerPerms, role } = yield* OrgPrincipal;
        const body = yield* decodeBody(
          InviteBody,
          yield* fieldsOf(yield* readJson(request)),
          "Invalid invitation",
        );
        const email = body.email;

        // The free plan is a single user, so any invite means upgrading first.
        // Paid orgs skip this and hit the seat gate below instead. No trial
        // gate is needed: agents are denied this route (`AGENT_DENY_RULES`: an
        // anonymous registration that can send mail from our domain is a spam
        // relay), and a trial org has no human members until a claim.
        const access = yield* legacy(() => planAccess(organizationId));
        if (!access.paid) {
          return yield* new PaymentRequired({
            error:
              access.reason === "inactive"
                ? `This organization's subscription is ${access.status}. Reactivate it under Settings → Billing to invite teammates.`
                : `The free plan includes ${FREE_PLAN_LIMITS.users} user. Upgrade to Pro to invite your team.`,
          });
        }

        // Prefer roleId; fall back to mapping the legacy text role to a system role.
        let target: TargetRole = { id: null, legacyRole: "member", permissions: [] };
        if (body.roleId) {
          const r = yield* findRole(organizationId, body.roleId);
          if (!r) return yield* notFound("Role not found");
          target = {
            id: r.id,
            legacyRole: isSystemRoleKey(r.systemKey) ? r.systemKey : "member",
            permissions: rolePermissions(r),
          };
        } else if (body.role) {
          const legacyRole = body.role;
          if (isSystemRoleKey(legacyRole)) {
            const sys = yield* legacy(() => getSystemRole(organizationId, legacyRole));
            target = { id: sys.id, legacyRole, permissions: sys.permissions };
          } else {
            target = { id: null, legacyRole, permissions: [] };
          }
        }

        // Privilege-escalation guards, identical to PATCH /members/:id/role.
        // Without them an invitation is a way around that route's checks:
        // `team:invite` is held by every admin, so an admin could invite an
        // address they control as an owner and accept their way to `*`.
        if (!isSubsetOfCallerPerms(target.permissions, callerPerms)) {
          return yield* forbidden("Cannot invite with a role granting permissions you do not hold");
        }
        if (target.legacyRole === "owner" && role?.systemKey !== "owner") {
          return yield* forbidden("Only an owner can invite someone as an owner");
        }

        // Seat gate: on a paid plan every member and pending invite occupies a
        // seat. Inviting past capacity needs an explicit `addSeat` opt-in.
        const seatLimit = yield* legacy(() => checkSeatAvailability(organizationId));
        let seatAdded = false;
        if (seatLimit) {
          // Capacity made only of prepaid slots has no monthly item to grow:
          // refuse before reading `addSeat`, a clear 409 rather than a 502.
          if (!seatLimit.canAddSeat) {
            return yield* new SeatLimitReached({
              error:
                `All ${seatLimit.seatCount} prepaid seats are in use. ` +
                `Buy another capacity slot under Settings → Billing to invite more teammates.`,
              code: "seat_limit_reached",
              seatCount: seatLimit.seatCount,
              seatsUsed: seatLimit.seatsUsed,
              canAddSeat: false,
            });
          }
          if (!body.addSeat) {
            return yield* new SeatLimitReached({
              error: `All ${seatLimit.seatCount} seats are in use. Add a seat to send this invitation.`,
              code: "seat_limit_reached",
              seatCount: seatLimit.seatCount,
              seatsUsed: seatLimit.seatsUsed,
              canAddSeat: true,
            });
          }
          // Buying a seat is a billing change, not a team change.
          yield* requirePermission("billing:write");
          const purchase = yield* legacy(() =>
            addSeat(organizationId).then(
              () => true,
              (err: unknown) => {
                console.error(`[team] adding a seat for org ${organizationId} failed:`, err);
                return false;
              },
            ),
          );
          if (!purchase) {
            return yield* new SeatPurchaseFailed({
              error: "Adding a seat failed, so the invitation was not sent.",
            });
          }
          seatAdded = true;
        }

        // Store only the SHA-256 hash. The raw token is returned exactly once
        // so the invite URL can be built; a DB read leak cannot weaponize it.
        const token = randomBytes(32).toString("base64url");
        const hashedToken = createHash("sha256").update(token).digest("hex");
        const id = uuid();
        yield* legacy(() =>
          db.insert(invitations).values({
            id,
            organizationId,
            email,
            role: target.legacyRole,
            roleId: target.id,
            invitedByUserId: session.userId,
            hashedToken,
            expiresAt: inviteExpiry(access),
          }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "member.invite",
            entityType: "member",
            entityId: id,
            metadata: { email, role: target.legacyRole, roleId: target.id, seatAdded },
          }),
        );
        return yield* respond(InviteResponse)({ id, token });
      }),
    )
    .handle("removeMember", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session, role } = yield* OrgPrincipal;
        const userId = params.id;
        const targetIsOwner = yield* legacy(() => isMemberOwner(organizationId, userId));
        if (targetIsOwner) {
          // Only an owner can remove an owner.
          if (role?.systemKey !== "owner") {
            return yield* forbidden("Only an owner can remove another owner");
          }
          const ownerCount = yield* legacy(() => countOwners(organizationId));
          if (ownerCount <= 1) return yield* badRequest("Cannot remove the last owner");
        }

        const revokedApiKeyIds = yield* legacy(() => removeMembership(organizationId, userId));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "member.remove",
            entityType: "member",
            entityId: userId,
            metadata: { revokedApiKeyIds },
          }),
        );
        // Best-effort: the member is already out either way, and the seat can
        // still be dropped by hand in the Stripe portal if this fails.
        yield* legacy(() =>
          releaseSeat(organizationId).catch((err: unknown) => {
            console.error(`[team] releasing a seat for org ${organizationId} failed:`, err);
          }),
        );
        return ok;
      }),
    )
    // Accepts either `{ roleId }` (preferred) or a legacy `{ role }` system role name.
    .handleRaw("changeMemberRole", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session, permissions: callerPerms, role } = yield* OrgPrincipal;
        const userId = params.id;
        const body = yield* decodeBody(
          RoleChangeBody,
          yield* fieldsOf(yield* readJson(request)),
          "Provide roleId or a system role name",
        );

        let target: TargetRole & { readonly id: string };
        if (body.roleId) {
          const r = yield* findRole(organizationId, body.roleId);
          if (!r) return yield* notFound("Role not found");
          target = {
            id: r.id,
            legacyRole: isSystemRoleKey(r.systemKey) ? r.systemKey : "member",
            permissions: rolePermissions(r),
          };
        } else if (body.role && isSystemRoleKey(body.role)) {
          const legacyRole = body.role;
          const sys = yield* legacy(() => getSystemRole(organizationId, legacyRole));
          target = { id: sys.id, legacyRole, permissions: sys.permissions };
        } else {
          return yield* badRequest("Provide roleId or a system role name");
        }

        // Privilege-escalation guard: the role being assigned must be a subset
        // of the caller's effective permissions, so an admin who can write
        // roles cannot lift a member above themselves (billing:write via a "*"
        // custom role).
        if (!isSubsetOfCallerPerms(target.permissions, callerPerms)) {
          return yield* forbidden("Cannot assign a role with permissions you do not hold");
        }

        // Owner-mutation guards. Only an owner may demote an owner, and
        // demoting the last remaining owner is never allowed.
        const targetIsOwner = yield* legacy(() => isMemberOwner(organizationId, userId));
        const movingToOwner = target.legacyRole === "owner";
        if ((targetIsOwner || movingToOwner) && role?.systemKey !== "owner") {
          return yield* forbidden(
            "Only an owner can change an owner's role or grant the owner role",
          );
        }
        if (targetIsOwner && !movingToOwner) {
          const ownerCount = yield* legacy(() => countOwners(organizationId));
          if (ownerCount <= 1) return yield* badRequest("Cannot remove the last owner");
        }

        yield* legacy(() =>
          db
            .update(organizationMembers)
            .set({ role: target.legacyRole, roleId: target.id })
            .where(
              and(
                eq(organizationMembers.userId, userId),
                eq(organizationMembers.organizationId, organizationId),
              ),
            ),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "member.role_change",
            entityType: "member",
            entityId: userId,
            metadata: { newRoleId: target.id, legacyRole: target.legacyRole },
          }),
        );
        return ok;
      }),
    )
    .handle("revokeInvitation", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        yield* legacy(() =>
          db
            .delete(invitations)
            .where(
              and(
                eq(invitations.id, params.id),
                eq(invitations.organizationId, organizationId),
                isNull(invitations.acceptedAt),
              ),
            ),
        );
        return ok;
      }),
    ),
);

export const teamDomain = makeDomain("team", TeamApi, TeamHandlers);
