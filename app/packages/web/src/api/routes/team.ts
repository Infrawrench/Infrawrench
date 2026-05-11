import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { users, invitations, organizationMembers, roles } from "../../db/schema";
import { logAudit } from "../../services/audit";
import { requirePermission } from "../../auth/permissions";
import {
  ALL_PERMISSIONS,
  ensureSystemRoles,
  getSystemRole,
  isSubsetOfCallerPerms,
  isSystemRoleKey,
  systemRolePermissions,
} from "@infrawrench/server-core/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
  }
}

const app = new Hono();

interface SerializedRole {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  systemKey: string | null;
  permissions: string[];
}

function serializeRole(row: typeof roles.$inferSelect): SerializedRole {
  const permissions =
    row.isSystem && isSystemRoleKey(row.systemKey)
      ? [...(systemRolePermissions(row.systemKey) ?? [])]
      : ((row.permissions as string[]) ?? []);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    systemKey: row.systemKey,
    permissions,
  };
}

/** GET /api/org/:orgId/team/me — current user's effective permissions and role. */
app.get("/me", async (c) => {
  const role = c.get("role");
  const permissions = c.get("permissions") ?? [];
  const session = c.get("session");
  return c.json({
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
  });
});

/** GET /api/org/:orgId/team/permissions — catalog of all known permission strings. */
app.get("/permissions", async (c) => {
  requirePermission(c, "team:read");
  return c.json({ permissions: [...ALL_PERMISSIONS] });
});

/** GET /api/org/:orgId/team/roles — list all roles (system + custom). */
app.get("/roles", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  await ensureSystemRoles(organizationId);
  const rows = await db.select().from(roles).where(eq(roles.organizationId, organizationId));
  return c.json(rows.map(serializeRole));
});

/** POST /api/org/:orgId/team/roles — create a custom role. */
app.post("/roles", async (c) => {
  requirePermission(c, "team:role:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const callerPerms = c.get("permissions") ?? [];
  const { name, description, permissions } = await c.req.json<{
    name: string;
    description?: string;
    permissions: string[];
  }>();
  if (!name?.trim()) return c.json({ error: "Name is required" }, 400);
  const cleanPerms = Array.isArray(permissions)
    ? permissions.filter((p) => typeof p === "string")
    : [];
  // Privilege-escalation guard: caller cannot grant permissions they don't hold.
  if (!isSubsetOfCallerPerms(cleanPerms, callerPerms)) {
    return c.json({ error: "Cannot grant permissions you do not hold yourself" }, 403);
  }
  const id = uuid();
  await db.insert(roles).values({
    id,
    organizationId,
    name: name.trim(),
    description: description?.trim() || null,
    isSystem: false,
    systemKey: null,
    permissions: cleanPerms,
  });
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "role.create",
    entityType: "role",
    entityId: id,
    metadata: { name: name.trim(), permissions: cleanPerms },
  });
  const [row] = await db.select().from(roles).where(eq(roles.id, id));
  return c.json(row ? serializeRole(row) : { id, name: name.trim(), permissions: cleanPerms });
});

/** PATCH /api/org/:orgId/team/roles/:id — edit a custom role. */
app.patch("/roles/:id", async (c) => {
  requirePermission(c, "team:role:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const roleId = c.req.param("id");
  const { name, description, permissions } = await c.req.json<{
    name?: string;
    description?: string | null;
    permissions?: string[];
  }>();

  const [existing] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
    .limit(1);
  if (!existing) return c.json({ error: "Role not found" }, 404);
  if (existing.isSystem) return c.json({ error: "System roles cannot be edited" }, 422);

  const updates: Partial<typeof roles.$inferInsert> = { updatedAt: new Date() };
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (description !== undefined) updates.description = description?.toString().trim() || null;
  if (Array.isArray(permissions)) {
    const cleanPerms = permissions.filter((p) => typeof p === "string");
    const callerPerms = c.get("permissions") ?? [];
    // Privilege-escalation guard: caller cannot grant permissions they don't hold.
    if (!isSubsetOfCallerPerms(cleanPerms, callerPerms)) {
      return c.json({ error: "Cannot grant permissions you do not hold yourself" }, 403);
    }
    updates.permissions = cleanPerms;
  }

  await db.update(roles).set(updates).where(eq(roles.id, roleId));
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "role.update",
    entityType: "role",
    entityId: roleId,
    metadata: { updates },
  });
  const [row] = await db.select().from(roles).where(eq(roles.id, roleId));
  return c.json(row ? serializeRole(row) : { ok: true });
});

/** DELETE /api/org/:orgId/team/roles/:id — delete a custom role. */
app.delete("/roles/:id", async (c) => {
  requirePermission(c, "team:role:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const roleId = c.req.param("id");

  const [existing] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
    .limit(1);
  if (!existing) return c.json({ error: "Role not found" }, 404);
  if (existing.isSystem) return c.json({ error: "System roles cannot be deleted" }, 422);

  // Reject if any member or pending invitation still references the role.
  const [memberCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(organizationMembers)
    .where(eq(organizationMembers.roleId, roleId));
  if ((memberCount?.n ?? 0) > 0) {
    return c.json(
      {
        error: "Role is assigned to one or more members. Reassign them before deleting.",
      },
      409,
    );
  }
  const [inviteCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(invitations)
    .where(and(eq(invitations.roleId, roleId), isNull(invitations.acceptedAt)));
  if ((inviteCount?.n ?? 0) > 0) {
    return c.json(
      {
        error: "Role is referenced by pending invitations. Cancel them before deleting.",
      },
      409,
    );
  }

  await db.delete(roles).where(eq(roles.id, roleId));
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "role.delete",
    entityType: "role",
    entityId: roleId,
  });
  return c.json({ ok: true });
});

/** GET /api/org/:orgId/team/members */
app.get("/members", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  const rows = await db
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
    .where(eq(organizationMembers.organizationId, organizationId));
  return c.json(rows);
});

/** GET /api/org/:orgId/team/invitations */
app.get("/invitations", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");
  const rows = await db
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
    .where(eq(invitations.organizationId, organizationId));
  return c.json(rows);
});

/** POST /api/org/:orgId/team/invitations */
app.post("/invitations", async (c) => {
  requirePermission(c, "team:invite");
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<{ email: string; role?: string; roleId?: string }>();
  const email = body.email;

  // Resolve the role: prefer explicit roleId, fall back to the legacy text role
  // mapped to a system role.
  let resolvedRoleId: string | null = null;
  let legacyRole = "member";
  if (body.roleId) {
    const [r] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, body.roleId), eq(roles.organizationId, organizationId)))
      .limit(1);
    if (!r) return c.json({ error: "Role not found" }, 404);
    resolvedRoleId = r.id;
    legacyRole = isSystemRoleKey(r.systemKey) ? r.systemKey : "member";
  } else if (body.role) {
    legacyRole = body.role;
    if (isSystemRoleKey(body.role)) {
      const sys = await getSystemRole(organizationId, body.role);
      resolvedRoleId = sys.id;
    }
  }

  // Generate a random invitation token and store only its SHA-256 hash.
  // The raw token is returned to the caller exactly once below so an invite
  // URL can be constructed; a DB read leak cannot weaponize the invite.
  const token = randomBytes(32).toString("base64url");
  const hashedToken = createHash("sha256").update(token).digest("hex");
  const id = uuid();

  await db.insert(invitations).values({
    id,
    organizationId,
    email,
    role: legacyRole,
    roleId: resolvedRoleId,
    invitedByUserId: session.userId,
    // Legacy `token` column retained for one release. Store a non-recoverable
    // placeholder so a DB leak does not expose a usable token.
    token: `hashed:${hashedToken}`,
    hashedToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "member.invite",
    entityType: "member",
    entityId: id,
    metadata: { email, role: legacyRole, roleId: resolvedRoleId },
  });

  return c.json({ id, token });
});

/**
 * Count active owners in the org. An owner is any member whose linked role row
 * has `systemKey = "owner"`, or (legacy fallback) whose
 * `organization_members.role` text column is "owner" when no role row is
 * linked. Used by the "last owner" guard on member delete / role change.
 */
async function countOwners(organizationId: string): Promise<number> {
  const rows = await db
    .select({
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
    })
    .from(organizationMembers)
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(eq(organizationMembers.organizationId, organizationId));
  let count = 0;
  for (const r of rows) {
    if (r.systemKey === "owner") count++;
    else if (!r.systemKey && r.legacyRole === "owner") count++;
  }
  return count;
}

/** Returns true if the membership row for (userId, orgId) is an owner. */
async function isMemberOwner(organizationId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
    })
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
  if (row.systemKey === "owner") return true;
  if (!row.systemKey && row.legacyRole === "owner") return true;
  return false;
}

/** DELETE /api/org/:orgId/team/members/:id */
app.delete("/members/:id", async (c) => {
  requirePermission(c, "team:remove");
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const userId = c.req.param("id");

  const targetIsOwner = await isMemberOwner(organizationId, userId);
  if (targetIsOwner) {
    // Only an owner can remove an owner.
    const callerRole = c.get("role");
    if (callerRole?.systemKey !== "owner") {
      return c.json({ error: "Only an owner can remove another owner" }, 403);
    }
    const ownerCount = await countOwners(organizationId);
    if (ownerCount <= 1) {
      return c.json({ error: "Cannot remove the last owner" }, 400);
    }
  }

  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    );

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "member.remove",
    entityType: "member",
    entityId: userId,
  });
  return c.json({ ok: true });
});

/**
 * PATCH /api/org/:orgId/team/members/:id/role
 *
 * Accepts either `{ roleId }` (preferred) or `{ role }` (legacy text role,
 * mapped to the matching system role).
 */
app.patch("/members/:id/role", async (c) => {
  requirePermission(c, "team:role:write");
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const userId = c.req.param("id");
  const body = await c.req.json<{ role?: string; roleId?: string }>();

  let newRoleId: string;
  let legacyRole = "member";
  let targetRolePerms: readonly string[] = [];
  if (body.roleId) {
    const [r] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, body.roleId), eq(roles.organizationId, organizationId)))
      .limit(1);
    if (!r) return c.json({ error: "Role not found" }, 404);
    newRoleId = r.id;
    legacyRole = isSystemRoleKey(r.systemKey) ? r.systemKey : "member";
    targetRolePerms =
      r.isSystem && isSystemRoleKey(r.systemKey)
        ? (systemRolePermissions(r.systemKey) ?? [])
        : ((r.permissions as string[]) ?? []);
  } else if (body.role && isSystemRoleKey(body.role)) {
    const sys = await getSystemRole(organizationId, body.role);
    newRoleId = sys.id;
    legacyRole = body.role;
    targetRolePerms = sys.permissions;
  } else {
    return c.json({ error: "Provide roleId or a system role name" }, 400);
  }

  // Privilege-escalation guard: the role being assigned must be a subset of
  // the caller's effective permissions. Prevents an admin (who can write
  // roles) from elevating a member to a role that grants permissions the
  // admin themselves lack (e.g. billing:write via a "*" custom role).
  const callerPerms = c.get("permissions") ?? [];
  if (!isSubsetOfCallerPerms(targetRolePerms, callerPerms)) {
    return c.json({ error: "Cannot assign a role with permissions you do not hold" }, 403);
  }

  // Owner-mutation guards. Only an owner may demote an owner, and demoting
  // the last remaining owner is never allowed.
  const callerRole = c.get("role");
  const targetIsOwner = await isMemberOwner(organizationId, userId);
  const movingToOwner = legacyRole === "owner";
  if ((targetIsOwner || movingToOwner) && callerRole?.systemKey !== "owner") {
    return c.json(
      { error: "Only an owner can change an owner's role or grant the owner role" },
      403,
    );
  }
  if (targetIsOwner && !movingToOwner) {
    const ownerCount = await countOwners(organizationId);
    if (ownerCount <= 1) {
      return c.json({ error: "Cannot remove the last owner" }, 400);
    }
  }

  await db
    .update(organizationMembers)
    .set({ role: legacyRole, roleId: newRoleId })
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    );

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "member.role_change",
    entityType: "member",
    entityId: userId,
    metadata: { newRoleId, legacyRole },
  });
  return c.json({ ok: true });
});

/** DELETE /api/org/:orgId/team/invitations/:id */
app.delete("/invitations/:id", async (c) => {
  requirePermission(c, "team:invite");
  const organizationId = c.get("organizationId");
  const invitationId = c.req.param("id");
  await db
    .delete(invitations)
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.organizationId, organizationId),
        isNull(invitations.acceptedAt),
      ),
    );
  return c.json({ ok: true });
});

export { app as teamRoutes };
