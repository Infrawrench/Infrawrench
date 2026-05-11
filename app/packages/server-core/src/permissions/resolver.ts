import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import { organizationMembers, roles } from "../db/schema";
import {
  SYSTEM_ROLE_DEFINITIONS,
  type SystemRoleKey,
  isSystemRoleKey,
  systemRolePermissions,
} from "./system-roles";

export interface ResolvedRole {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  systemKey: SystemRoleKey | null;
  permissions: readonly string[];
}

/**
 * Idempotently ensure the three system role rows (owner/admin/member) exist
 * for the given org. Safe to call on every membership change.
 */
export async function ensureSystemRoles(organizationId: string): Promise<void> {
  const existing = await db
    .select({ systemKey: roles.systemKey })
    .from(roles)
    .where(and(eq(roles.organizationId, organizationId), eq(roles.isSystem, true)));
  const present = new Set(existing.map((r) => r.systemKey));
  const toInsert = (Object.keys(SYSTEM_ROLE_DEFINITIONS) as SystemRoleKey[])
    .filter((key) => !present.has(key))
    .map((key) => {
      const def = SYSTEM_ROLE_DEFINITIONS[key];
      return {
        id: randomUUID(),
        organizationId,
        name: def.name,
        description: def.description,
        isSystem: true,
        systemKey: key,
        permissions: [],
      };
    });
  if (toInsert.length > 0) {
    await db.insert(roles).values(toInsert).onConflictDoNothing();
  }
}

/** Returns the system role row for `(orgId, systemKey)`, ensuring it exists first. */
export async function getSystemRole(
  organizationId: string,
  systemKey: SystemRoleKey,
): Promise<ResolvedRole> {
  await ensureSystemRoles(organizationId);
  const rows = await db
    .select()
    .from(roles)
    .where(and(eq(roles.organizationId, organizationId), eq(roles.systemKey, systemKey)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`System role ${systemKey} missing for org ${organizationId}`);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: true,
    systemKey,
    permissions: systemRolePermissions(systemKey) ?? [],
  };
}

export type Principal =
  | { kind: "user"; userId: string }
  | { kind: "apiKey"; scopes: readonly string[] };

export interface EffectiveAccess {
  permissions: readonly string[];
  role: ResolvedRole | null;
}

/**
 * Resolve the effective permissions for a principal in an organization.
 *
 * - For session users, returns the permissions of their assigned role
 *   (falling back to the legacy `organization_members.role` text column if
 *   `roleId` is not yet backfilled).
 * - For API keys, returns the key's stored scopes verbatim.
 */
export async function resolveEffectivePermissions(
  organizationId: string,
  principal: Principal,
): Promise<EffectiveAccess> {
  if (principal.kind === "apiKey") {
    return { permissions: principal.scopes, role: null };
  }
  const memberships = await db
    .select({
      roleId: organizationMembers.roleId,
      legacyRole: organizationMembers.role,
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, principal.userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  const m = memberships[0];
  if (!m) return { permissions: [], role: null };

  if (m.roleId) {
    const rows = await db.select().from(roles).where(eq(roles.id, m.roleId)).limit(1);
    const r = rows[0];
    if (r) {
      const isSystem = r.isSystem;
      const systemKey = isSystemRoleKey(r.systemKey) ? r.systemKey : null;
      const permissions =
        isSystem && systemKey ? (systemRolePermissions(systemKey) ?? []) : (r.permissions ?? []);
      return {
        permissions,
        role: {
          id: r.id,
          name: r.name,
          description: r.description,
          isSystem,
          systemKey,
          permissions,
        },
      };
    }
  }

  // Fallback: legacy text role column. Treat as a system role.
  if (isSystemRoleKey(m.legacyRole)) {
    const role = await getSystemRole(organizationId, m.legacyRole);
    return { permissions: role.permissions, role };
  }
  return { permissions: [], role: null };
}

/**
 * Ensure the membership row points at a real role row. If the user has no
 * `roleId`, looks up the matching system role (creating system rows if needed)
 * and assigns it. Returns the assigned role.
 */
export async function backfillMembershipRole(
  organizationId: string,
  userId: string,
): Promise<ResolvedRole | null> {
  const rows = await db
    .select({
      id: organizationMembers.id,
      roleId: organizationMembers.roleId,
      legacyRole: organizationMembers.role,
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  const m = rows[0];
  if (!m) return null;
  if (m.roleId) {
    const existing = await db.select().from(roles).where(eq(roles.id, m.roleId)).limit(1);
    const r = existing[0];
    if (r) {
      const systemKey = isSystemRoleKey(r.systemKey) ? r.systemKey : null;
      const permissions =
        r.isSystem && systemKey ? (systemRolePermissions(systemKey) ?? []) : (r.permissions ?? []);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        systemKey,
        permissions,
      };
    }
  }
  const key: SystemRoleKey = isSystemRoleKey(m.legacyRole) ? m.legacyRole : "member";
  const role = await getSystemRole(organizationId, key);
  await db
    .update(organizationMembers)
    .set({ roleId: role.id })
    .where(eq(organizationMembers.id, m.id));
  return role;
}
