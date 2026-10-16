/**
 * Per-user and per-role default dashboards: the one place that answers
 * "which dashboard does this member land on".
 *
 * Precedence is user, then role, then org (the pure rules, including the
 * multi-role tie-break, live in client-core `dashboard-defaults.ts`). This
 * module does the reads and the sharing checks around them:
 *
 * - **Reads** run as the request's sharing principal (`object-sharing.ts`),
 *   so a default the member can no longer open is skipped rather than
 *   rendered or 404'd.
 * - **Role writes** are validated against the role, not the admin making
 *   them: the role must hold `dashboards:read`, and the dashboard's sharing
 *   must let *that role* view it. Admins see everything through
 *   `sharing:override`, so checking as the admin would accept a dashboard
 *   none of the role's members can open.
 *
 * Storage is two nullable columns, `roles.default_dashboard_id` and
 * `organization_members.default_dashboard_id`, both `ON DELETE SET NULL`, so
 * deleting a dashboard quietly drops it as anyone's default.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  chooseDefaultDashboard,
  type DefaultDashboardResolution,
  type RoleDefaultDashboard,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  ensureSystemRoles,
  isSystemRoleKey,
  systemRolePermissions,
} from "@infrawrench/server-core/permissions";
import { db } from "../db/client";
import { dashboards, organizationMembers, roles } from "../db/schema";
import { filterVisibleObjects, runWithSharingPrincipal } from "./object-sharing";

/** A request or input problem the route answers with its `status`. */
export class DefaultDashboardError extends Error {
  override readonly name = "DefaultDashboardError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 422,
  ) {
    super(message);
  }
}

type RoleRow = typeof roles.$inferSelect;

/** What a role grants: system roles from code, custom roles as stored. */
function permissionsOfRole(row: RoleRow): readonly string[] {
  if (row.isSystem && isSystemRoleKey(row.systemKey)) {
    return systemRolePermissions(row.systemKey) ?? [];
  }
  return row.permissions ?? [];
}

/** The org default, created as "Home" the first time anyone asks for it. */
export async function getOrCreateOrgDefaultDashboard(
  organizationId: string,
): Promise<typeof dashboards.$inferSelect> {
  const [existing] = await db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, organizationId),
        eq(dashboards.isDefault, true),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(dashboards)
    .values({ id: uuidv4(), organizationId, name: "Home", isDefault: true })
    .returning();
  return created!;
}

/**
 * The roles a member holds. One today (`organization_members.role_id`, or the
 * system role matching the legacy text column on a row not yet backfilled);
 * a list so several roles stay a resolver concern, not a schema change.
 */
async function memberRoleRows(
  organizationId: string,
  member: { roleId: string | null; legacyRole: string },
): Promise<RoleRow[]> {
  if (member.roleId) {
    return db
      .select()
      .from(roles)
      .where(and(eq(roles.organizationId, organizationId), eq(roles.id, member.roleId)));
  }
  if (!isSystemRoleKey(member.legacyRole)) return [];
  return db
    .select()
    .from(roles)
    .where(and(eq(roles.organizationId, organizationId), eq(roles.systemKey, member.legacyRole)));
}

function toRoleDefault(row: RoleRow): RoleDefaultDashboard {
  return {
    roleId: row.id,
    roleName: row.name,
    isSystem: row.isSystem,
    systemKey: row.systemKey,
    dashboardId: row.defaultDashboardId,
  };
}

/**
 * Resolve the caller's default dashboard. Visibility is checked against the
 * sharing principal of the current request; with none (a system caller) every
 * dashboard counts as visible.
 */
export async function resolveDefaultDashboard(
  organizationId: string,
  userId: string,
): Promise<DefaultDashboardResolution> {
  const [member] = await db
    .select({
      roleId: organizationMembers.roleId,
      legacyRole: organizationMembers.role,
      defaultDashboardId: organizationMembers.defaultDashboardId,
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);

  const orgDefault = await getOrCreateOrgDefaultDashboard(organizationId);
  const roleRows = member ? await memberRoleRows(organizationId, member) : [];
  const candidates = {
    userDefaultDashboardId: member?.defaultDashboardId ?? null,
    roles: roleRows.map(toRoleDefault),
    orgDefaultDashboardId: orgDefault.id,
  };

  const ids = [
    ...new Set(
      [
        candidates.userDefaultDashboardId,
        ...candidates.roles.map((r) => r.dashboardId),
        orgDefault.id,
      ].filter((id): id is string => typeof id === "string"),
    ),
  ];
  const rows = await db
    .select({ id: dashboards.id, name: dashboards.name })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, organizationId),
        inArray(dashboards.id, ids),
        isNull(dashboards.deletedAt),
      ),
    );
  const visible = await filterVisibleObjects(organizationId, "dashboard", rows, (r) => r.id);
  const nameById = new Map(visible.map((r) => [r.id, r.name]));

  const choice = chooseDefaultDashboard(candidates, (id) => nameById.has(id));
  return {
    ...choice,
    dashboardName: nameById.get(choice.dashboardId) ?? orgDefault.name,
  };
}

/** Load a live dashboard in the org, or throw a 404. */
async function requireDashboard(organizationId: string, dashboardId: string) {
  const [row] = await db
    .select({ id: dashboards.id, name: dashboards.name })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, organizationId),
        eq(dashboards.id, dashboardId),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new DefaultDashboardError("Dashboard not found", 404);
  return row;
}

/**
 * Set the caller's own default. The dashboard must be one they can open now;
 * a later unshare is handled by resolution skipping it.
 */
export async function setMyDefaultDashboard(
  organizationId: string,
  userId: string,
  dashboardId: string,
): Promise<{ id: string; name: string }> {
  const row = await requireDashboard(organizationId, dashboardId);
  const visible = await filterVisibleObjects(organizationId, "dashboard", [row], (r) => r.id);
  // Answered as 404, like every other object a caller cannot see.
  if (visible.length === 0) throw new DefaultDashboardError("Dashboard not found", 404);
  await db
    .update(organizationMembers)
    .set({ defaultDashboardId: dashboardId })
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
  return row;
}

export async function clearMyDefaultDashboard(
  organizationId: string,
  userId: string,
): Promise<void> {
  await db
    .update(organizationMembers)
    .set({ defaultDashboardId: null })
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
}

/** Every role in the org with its default (system rows created if missing). */
export async function listRoleDefaultDashboards(
  organizationId: string,
): Promise<RoleDefaultDashboard[]> {
  await ensureSystemRoles(organizationId);
  const rows = await db
    .select()
    .from(roles)
    .where(eq(roles.organizationId, organizationId))
    .orderBy(asc(roles.createdAt), asc(roles.id));
  return rows.map(toRoleDefault);
}

async function requireRole(organizationId: string, roleId: string): Promise<RoleRow> {
  const [row] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.organizationId, organizationId), eq(roles.id, roleId)))
    .limit(1);
  if (!row) throw new DefaultDashboardError("Role not found", 404);
  return row;
}

/**
 * The half of {@link roleDefaultProblem} that needs no dashboard: a role
 * without `dashboards:read` can never land on one. Org-config apply uses it
 * alone for a dashboard the same document creates (nothing has narrowed its
 * sharing yet, so the org-wide default applies).
 */
export function rolePermissionProblem(role: RoleRow): string | null {
  if (hasPermission(permissionsOfRole(role), "dashboards:read")) return null;
  return `The ${role.name} role cannot view dashboards (it lacks dashboards:read), so a default dashboard would never apply to it.`;
}

/**
 * Why `role` could not use `dashboardId` as its default, or null when it can.
 * Exported for the org-config apply, which validates the same way.
 */
export async function roleDefaultProblem(
  organizationId: string,
  role: RoleRow,
  dashboardId: string,
): Promise<string | null> {
  const permissionProblem = rolePermissionProblem(role);
  if (permissionProblem) return permissionProblem;
  if (hasPermission(permissionsOfRole(role), "sharing:override")) return null;
  const [row] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, organizationId),
        eq(dashboards.id, dashboardId),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return "Dashboard not found";
  // Evaluate the dashboard's sharing as a member of the role who has no grant
  // of their own: the org-wide level plus any grant to the role.
  const visible = await runWithSharingPrincipal(
    { organizationId, userId: "", roleId: role.id, override: false },
    () => filterVisibleObjects(organizationId, "dashboard", [row], (r) => r.id),
  );
  if (visible.length === 0) {
    return `This dashboard is not shared with the ${role.name} role. Share it with the role (or the whole organization) first.`;
  }
  return null;
}

export async function setRoleDefaultDashboard(
  organizationId: string,
  roleId: string,
  dashboardId: string,
): Promise<{ role: RoleRow; dashboard: { id: string; name: string } }> {
  const role = await requireRole(organizationId, roleId);
  const dashboard = await requireDashboard(organizationId, dashboardId);
  const problem = await roleDefaultProblem(organizationId, role, dashboardId);
  if (problem) throw new DefaultDashboardError(problem, 422);
  await db
    .update(roles)
    .set({ defaultDashboardId: dashboardId, updatedAt: new Date() })
    .where(eq(roles.id, roleId));
  return { role, dashboard };
}

export async function clearRoleDefaultDashboard(
  organizationId: string,
  roleId: string,
): Promise<RoleRow> {
  const role = await requireRole(organizationId, roleId);
  await db
    .update(roles)
    .set({ defaultDashboardId: null, updatedAt: new Date() })
    .where(eq(roles.id, roleId));
  return role;
}
