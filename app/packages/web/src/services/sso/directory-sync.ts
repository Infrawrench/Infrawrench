/**
 * SCIM directory sync: turning WorkOS Directory Sync users into memberships,
 * taking them away again, and keeping each member's role in step with their
 * IdP groups.
 *
 * Three entry points share every decision here: the signed webhook (one user
 * at a time, as the IdP changes), the full reconcile behind "Sync now" (every
 * user, which also repairs any webhook we missed), and sign-in (one member,
 * so a group change in the IdP lands at their next sign-in even if its event
 * never arrived).
 *
 * The invariants, each enforced below rather than trusted to the caller:
 *
 *  - Nothing is provisioned for an email outside the org's **verified
 *    domains**. A directory is configured by the customer's IT admin; without
 *    this, one could pull any Infrawrench user with any address into the org.
 *  - Nothing changes membership while **provisioning is off**. The directory
 *    is observed (so the preview has something to show) and that is all.
 *  - The **last owner is never removed** and **owners' roles are never
 *    changed** by the directory (see `group-roles.ts`).
 *  - **No seat is bought** unless the org opted into it.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  getSystemRole,
  isSystemRoleKey,
  type SystemRoleKey,
} from "@infrawrench/server-core/permissions";
import type {
  SsoDirectoryMemberStatus,
  SsoMappingPreviewRow,
  SsoSyncResult,
} from "@infrawrench/client-core";
import { db } from "../../db/client";
import {
  organizationMembers,
  roles,
  ssoDirectoryMembers,
  ssoGroupRoleMappings,
  users,
} from "../../db/schema";
import { logAudit } from "../audit";
import { planAccess } from "../entitlements";
import { removeOrgMember } from "../member-removal";
import { countOwners } from "../org-owners";
import { isOwnerRole } from "../org-roles";
import { addSeat, checkSeatAvailability } from "../seats";
import {
  isInVerifiedDomains,
  orderMappings,
  resolveDirectoryRole,
  type GroupRoleMapping,
} from "./group-roles";
import { updateSsoSettings, type SsoSettingsRow } from "./settings";
import * as wos from "./workos-api";

/** How long a member's stored groups count as fresh enough to skip a WorkOS read at sign-in. */
const LOGIN_REFRESH_AFTER_MS = 5 * 60 * 1000;

type DirectoryMemberRow = typeof ssoDirectoryMembers.$inferSelect;

export type SyncSource = "webhook" | "reconcile" | "login";

interface MembershipInfo {
  roleId: string | null;
  isOwner: boolean;
}

async function membership(organizationId: string, userId: string): Promise<MembershipInfo | null> {
  const [row] = await db
    .select({
      roleId: organizationMembers.roleId,
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
    })
    .from(organizationMembers)
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { roleId: row.roleId, isOwner: isOwnerRole(row.systemKey, row.legacyRole) };
}

export async function loadMappings(organizationId: string): Promise<GroupRoleMapping[]> {
  const rows = await db
    .select()
    .from(ssoGroupRoleMappings)
    .where(eq(ssoGroupRoleMappings.organizationId, organizationId));
  return orderMappings(rows);
}

/** The org's default role for provisioned members: its choice, else the system `member` role. */
export async function defaultRoleIdFor(settings: SsoSettingsRow): Promise<string> {
  if (settings.defaultRoleId) {
    const [r] = await db
      .select({ id: roles.id, systemKey: roles.systemKey })
      .from(roles)
      .where(
        and(
          eq(roles.id, settings.defaultRoleId),
          eq(roles.organizationId, settings.organizationId),
        ),
      )
      .limit(1);
    if (r && r.systemKey !== "owner") return r.id;
  }
  return (await getSystemRole(settings.organizationId, "member")).id;
}

/**
 * Point a membership at a role. Refuses the owner role outright: there is no
 * path by which the directory may mint an owner, whatever a row says.
 * Returns whether anything changed.
 */
async function setMemberRole(
  organizationId: string,
  userId: string,
  roleId: string,
): Promise<boolean> {
  const [r] = await db
    .select({ id: roles.id, systemKey: roles.systemKey })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
    .limit(1);
  if (!r || r.systemKey === "owner") return false;
  const legacyRole: SystemRoleKey | "member" =
    r.systemKey && isSystemRoleKey(r.systemKey) ? r.systemKey : "member";
  const updated = await db
    .update(organizationMembers)
    .set({ roleId: r.id, role: legacyRole })
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
        ne(organizationMembers.roleId, r.id),
      ),
    )
    .returning({ id: organizationMembers.id });
  // A row whose role_id is still NULL (pre-backfill) is not matched by `ne`;
  // set it explicitly.
  if (updated.length === 0) {
    const legacy = await db
      .select({ roleId: organizationMembers.roleId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    if (legacy[0] && legacy[0].roleId === null) {
      await db
        .update(organizationMembers)
        .set({ roleId: r.id, role: legacyRole })
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, userId),
          ),
        );
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Apply the group mappings to one member. Returns the role change, or null
 * when nothing changed (owner, no membership, already right).
 */
export async function applyDirectoryRole(
  settings: SsoSettingsRow,
  userId: string,
  groupIds: readonly string[],
  source: SyncSource,
  mappings?: readonly GroupRoleMapping[],
): Promise<{ from: string | null; to: string } | null> {
  const member = await membership(settings.organizationId, userId);
  if (!member) return null;
  const resolution = resolveDirectoryRole({
    groupIds,
    mappings: mappings ?? (await loadMappings(settings.organizationId)),
    defaultRoleId: await defaultRoleIdFor(settings),
    currentIsOwner: member.isOwner,
  });
  if (!resolution.roleId || resolution.roleId === member.roleId) return null;
  const changed = await setMemberRole(settings.organizationId, userId, resolution.roleId);
  if (!changed) return null;
  void logAudit({
    organizationId: settings.organizationId,
    action: "sso.member_role_change",
    entityType: "member",
    entityId: userId,
    metadata: {
      source,
      fromRoleId: member.roleId,
      toRoleId: resolution.roleId,
      mappingId: resolution.mappingId,
      conflict: resolution.conflict,
    },
  });
  return { from: member.roleId, to: resolution.roleId };
}

async function upsertDirectoryRow(
  organizationId: string,
  user: wos.WorkosDirectoryUser,
  patch: Partial<DirectoryMemberRow> & { status: SsoDirectoryMemberStatus },
): Promise<DirectoryMemberRow> {
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;
  const values = {
    id: uuid(),
    organizationId,
    directoryId: user.directoryId,
    directoryUserId: user.id,
    email: user.email ?? "",
    displayName,
    groupIds: user.groups.map((g) => g.id),
    lastSyncedAt: new Date(),
    ...patch,
  };
  const { id: _id, organizationId: _org, directoryUserId: _du, ...update } = values;
  const [row] = await db
    .insert(ssoDirectoryMembers)
    .values(values)
    .onConflictDoUpdate({
      target: [ssoDirectoryMembers.organizationId, ssoDirectoryMembers.directoryUserId],
      set: update,
    })
    .returning();
  return row!;
}

async function existingDirectoryRow(
  organizationId: string,
  directoryUserId: string,
): Promise<DirectoryMemberRow | null> {
  const [row] = await db
    .select()
    .from(ssoDirectoryMembers)
    .where(
      and(
        eq(ssoDirectoryMembers.organizationId, organizationId),
        eq(ssoDirectoryMembers.directoryUserId, directoryUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The Infrawrench user for an email, provisioning the WorkOS user and our row if needed. */
async function resolveUserForEmail(user: wos.WorkosDirectoryUser): Promise<string> {
  const email = user.email!;
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing) return existing.id;
  const wu = await wos.findOrCreateUser({
    email,
    firstName: user.firstName,
    lastName: user.lastName,
  });
  await db
    .insert(users)
    .values({
      id: wu.id,
      email: wu.email.toLowerCase(),
      displayName: `${wu.firstName ?? ""} ${wu.lastName ?? ""}`.trim() || null,
    })
    .onConflictDoNothing();
  return wu.id;
}

export type DirectoryUserOutcome =
  "provisioned" | "linked" | "role_changed" | "unchanged" | "deprovisioned" | "skipped";

/** Bring one directory user's membership and role in line with the directory. */
export async function syncDirectoryUser(
  settings: SsoSettingsRow,
  user: wos.WorkosDirectoryUser,
  source: SyncSource,
  mappings?: readonly GroupRoleMapping[],
): Promise<DirectoryUserOutcome> {
  const organizationId = settings.organizationId;
  if (user.state !== "active") {
    return await deprovisionDirectoryUser(settings, user.id, source, user);
  }
  if (!user.email) return "skipped";

  if (!isInVerifiedDomains(user.email, settings.verifiedDomains)) {
    await upsertDirectoryRow(organizationId, user, { status: "domain_unverified" });
    return "skipped";
  }

  const prior = await existingDirectoryRow(organizationId, user.id);

  if (!settings.provisioningEnabled) {
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${user.email}`)
      .limit(1);
    await upsertDirectoryRow(organizationId, user, {
      status: "observed",
      userId: existingUser?.id ?? prior?.userId ?? null,
    });
    return "skipped";
  }

  const userId = await resolveUserForEmail(user);
  const groupIds = user.groups.map((g) => g.id);
  const member = await membership(organizationId, userId);

  if (member) {
    await upsertDirectoryRow(organizationId, user, {
      status: "active",
      userId,
      deprovisionedAt: null,
      provisionedByDirectory: prior?.provisionedByDirectory ?? false,
    });
    const change = await applyDirectoryRole(settings, userId, groupIds, source, mappings);
    if (change) return "role_changed";
    return prior?.userId === userId && prior.status === "active" ? "unchanged" : "linked";
  }

  // A new membership: the plan and a seat first.
  const access = await planAccess(organizationId);
  if (!access.paid) {
    await upsertDirectoryRow(organizationId, user, { status: "plan_required", userId });
    return "skipped";
  }
  const seatLimit = await checkSeatAvailability(organizationId);
  if (seatLimit) {
    if (!settings.autoAddSeats || !seatLimit.canAddSeat) {
      await upsertDirectoryRow(organizationId, user, { status: "seat_limit", userId });
      return "skipped";
    }
    try {
      await addSeat(organizationId);
    } catch (err) {
      console.error(`[sso] adding a seat for org ${organizationId} failed:`, err);
      await upsertDirectoryRow(organizationId, user, { status: "seat_limit", userId });
      return "skipped";
    }
  }

  const resolution = resolveDirectoryRole({
    groupIds,
    mappings: mappings ?? (await loadMappings(organizationId)),
    defaultRoleId: await defaultRoleIdFor(settings),
    currentIsOwner: false,
  });
  const roleId = resolution.roleId!;
  const [roleRow] = await db
    .select({ systemKey: roles.systemKey })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);
  const legacyRole =
    roleRow?.systemKey && isSystemRoleKey(roleRow.systemKey) && roleRow.systemKey !== "owner"
      ? roleRow.systemKey
      : "member";

  await db
    .insert(organizationMembers)
    .values({ id: uuid(), userId, organizationId, role: legacyRole, roleId })
    .onConflictDoNothing();
  await upsertDirectoryRow(organizationId, user, {
    status: "active",
    userId,
    provisionedByDirectory: true,
    deprovisionedAt: null,
  });
  void logAudit({
    organizationId,
    action: "sso.member_provisioned",
    entityType: "member",
    entityId: userId,
    metadata: {
      source,
      email: user.email,
      directoryId: user.directoryId,
      roleId,
      mappingId: resolution.mappingId,
    },
  });
  return "provisioned";
}

/**
 * Remove a directory user's access. Keeps the directory row (as
 * `deprovisioned`) so the page can show who left and when.
 */
export async function deprovisionDirectoryUser(
  settings: SsoSettingsRow,
  directoryUserId: string,
  source: SyncSource,
  snapshot?: wos.WorkosDirectoryUser,
): Promise<DirectoryUserOutcome> {
  const organizationId = settings.organizationId;
  const row = await existingDirectoryRow(organizationId, directoryUserId);
  if (!row) {
    if (snapshot?.email) {
      await upsertDirectoryRow(organizationId, snapshot, {
        status: "deprovisioned",
        deprovisionedAt: new Date(),
      });
    }
    return "skipped";
  }
  if (row.status === "deprovisioned") return "unchanged";

  const markDeprovisioned = () =>
    db
      .update(ssoDirectoryMembers)
      .set({ status: "deprovisioned", deprovisionedAt: new Date(), lastSyncedAt: new Date() })
      .where(eq(ssoDirectoryMembers.id, row.id));

  if (!row.userId || !settings.provisioningEnabled) {
    await markDeprovisioned();
    return "skipped";
  }

  const member = await membership(organizationId, row.userId);
  if (!member) {
    await markDeprovisioned();
    return "unchanged";
  }

  // Lockout guard: the directory may not remove the last person who can
  // administer the org, exactly as an owner on the team page may not.
  if (member.isOwner && (await countOwners(organizationId)) <= 1) {
    await db
      .update(ssoDirectoryMembers)
      .set({ status: "protected", lastSyncedAt: new Date() })
      .where(eq(ssoDirectoryMembers.id, row.id));
    void logAudit({
      organizationId,
      action: "sso.deprovision_refused",
      entityType: "member",
      entityId: row.userId,
      metadata: { source, email: row.email, reason: "last_owner" },
    });
    return "skipped";
  }

  const { revokedApiKeyIds } = await removeOrgMember(organizationId, row.userId);
  await markDeprovisioned();

  // A break-glass owner who has left the company is the last account that
  // should keep a way around SSO.
  if (settings.breakGlassUserIds.includes(row.userId)) {
    await updateSsoSettings(organizationId, {
      breakGlassUserIds: settings.breakGlassUserIds.filter((id) => id !== row.userId),
    });
  }

  // Membership is checked on every request, so access to this org is already
  // gone. Their WorkOS sessions are ended too when this was their only org:
  // that is the "sign them out" an IT admin expects from deprovisioning, and
  // a person who still belongs to other orgs keeps their sessions there.
  let sessionsRevoked = 0;
  const remaining = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, row.userId))
    .limit(1);
  if (remaining.length === 0) {
    try {
      sessionsRevoked = await wos.revokeAllSessions(row.userId);
    } catch (err) {
      console.error(`[sso] revoking sessions for ${row.userId} failed:`, err);
    }
  }

  void logAudit({
    organizationId,
    action: "sso.member_deprovisioned",
    entityType: "member",
    entityId: row.userId,
    metadata: { source, email: row.email, revokedApiKeyIds, sessionsRevoked },
  });
  return "deprovisioned";
}

/**
 * Walk every active directory of the org and sync every user. Users we hold a
 * row for that the directory no longer returns are deprovisioned, but only
 * for directories whose listing succeeded: a failed read is never evidence
 * that everybody left.
 */
export async function reconcileDirectories(settings: SsoSettingsRow): Promise<SsoSyncResult> {
  const result: SsoSyncResult = {
    usersSeen: 0,
    provisioned: 0,
    deprovisioned: 0,
    rolesChanged: 0,
    skipped: 0,
  };
  const directories = await wos.listDirectories(settings.workosOrganizationId);
  const mappings = await loadMappings(settings.organizationId);
  for (const dir of directories) {
    if (dir.state !== "active") continue;
    const dirUsers = await wos.listDirectoryUsers(dir.id);
    const seen = new Set<string>();
    for (const u of dirUsers) {
      seen.add(u.id);
      result.usersSeen++;
      const outcome = await syncDirectoryUser(settings, u, "reconcile", mappings);
      if (outcome === "provisioned") result.provisioned++;
      else if (outcome === "deprovisioned") result.deprovisioned++;
      else if (outcome === "role_changed") result.rolesChanged++;
      else if (outcome === "skipped") result.skipped++;
    }
    const stored = await db
      .select({ directoryUserId: ssoDirectoryMembers.directoryUserId })
      .from(ssoDirectoryMembers)
      .where(
        and(
          eq(ssoDirectoryMembers.organizationId, settings.organizationId),
          eq(ssoDirectoryMembers.directoryId, dir.id),
          inArray(ssoDirectoryMembers.status, ["active", "observed", "protected"]),
        ),
      );
    for (const s of stored) {
      if (seen.has(s.directoryUserId)) continue;
      const outcome = await deprovisionDirectoryUser(settings, s.directoryUserId, "reconcile");
      if (outcome === "deprovisioned") result.deprovisioned++;
    }
  }
  return result;
}

/**
 * Re-apply the mappings for one member as they sign in. Uses the stored
 * groups when they are recent, otherwise asks WorkOS for the current ones.
 * Never throws: sign-in must not fail because the directory is slow.
 */
export async function applyRolesOnLogin(
  settings: SsoSettingsRow,
  userId: string,
): Promise<boolean> {
  try {
    if (!settings.provisioningEnabled) return false;
    const [row] = await db
      .select()
      .from(ssoDirectoryMembers)
      .where(
        and(
          eq(ssoDirectoryMembers.organizationId, settings.organizationId),
          eq(ssoDirectoryMembers.userId, userId),
          eq(ssoDirectoryMembers.status, "active"),
        ),
      )
      .limit(1);
    if (!row) return false;
    let groupIds = row.groupIds;
    if (Date.now() - row.lastSyncedAt.getTime() > LOGIN_REFRESH_AFTER_MS) {
      const fresh = await wos.getDirectoryUser(row.directoryUserId);
      if (fresh.state !== "active") {
        await deprovisionDirectoryUser(settings, row.directoryUserId, "login", fresh);
        return true;
      }
      groupIds = fresh.groups.map((g) => g.id);
      await db
        .update(ssoDirectoryMembers)
        .set({ groupIds, lastSyncedAt: new Date() })
        .where(eq(ssoDirectoryMembers.id, row.id));
    }
    return (await applyDirectoryRole(settings, userId, groupIds, "login")) !== null;
  } catch (err) {
    console.error(`[sso] applying roles at sign-in for ${userId} failed:`, err);
    return false;
  }
}

/**
 * What the mappings would do to every directory member, without doing it.
 * Takes unsaved mappings so the page can preview an edit before saving it.
 */
export async function previewMappings(
  settings: SsoSettingsRow,
  mappings: readonly GroupRoleMapping[],
  defaultRoleId: string | null,
): Promise<SsoMappingPreviewRow[]> {
  const organizationId = settings.organizationId;
  const rows = await db
    .select()
    .from(ssoDirectoryMembers)
    .where(
      and(
        eq(ssoDirectoryMembers.organizationId, organizationId),
        inArray(ssoDirectoryMembers.status, ["active", "observed", "seat_limit", "protected"]),
      ),
    );
  const roleRows = await db
    .select({ id: roles.id, name: roles.name, systemKey: roles.systemKey })
    .from(roles)
    .where(eq(roles.organizationId, organizationId));
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  const fallback =
    defaultRoleId && roleRows.some((r) => r.id === defaultRoleId && r.systemKey !== "owner")
      ? defaultRoleId
      : await defaultRoleIdFor({ ...settings, defaultRoleId: null });
  const memberRows = await db
    .select({
      userId: organizationMembers.userId,
      roleId: organizationMembers.roleId,
      legacyRole: organizationMembers.role,
      systemKey: roles.systemKey,
    })
    .from(organizationMembers)
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(eq(organizationMembers.organizationId, organizationId));
  const members = new Map(memberRows.map((m) => [m.userId, m]));
  const ordered = orderMappings(mappings);
  const byId = new Map(ordered.map((m) => [m.id, m]));

  return rows.map((r) => {
    const m = r.userId ? members.get(r.userId) : undefined;
    const currentIsOwner = m ? isOwnerRole(m.systemKey, m.legacyRole) : false;
    const res = resolveDirectoryRole({
      groupIds: r.groupIds,
      mappings: ordered,
      defaultRoleId: fallback,
      currentIsOwner,
    });
    const currentRoleId = m?.roleId ?? null;
    return {
      userId: r.userId,
      email: r.email,
      status: r.status as SsoDirectoryMemberStatus,
      currentRoleId,
      currentRoleName: currentRoleId ? (roleName.get(currentRoleId) ?? null) : null,
      resolvedRoleId: res.roleId,
      resolvedRoleName: res.roleId ? (roleName.get(res.roleId) ?? null) : null,
      source: res.source,
      matchedGroupNames: res.matchedMappingIds
        .map((id) => byId.get(id)?.groupName)
        .filter((n): n is string => !!n),
      conflict: res.conflict,
      changes: res.roleId !== null && res.roleId !== currentRoleId,
    };
  });
}
