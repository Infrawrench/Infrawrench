/**
 * Which dashboard a member lands on when the app opens "the dashboard".
 *
 * Three layers, most specific first:
 *
 * 1. **user**: the member's own "My default dashboard".
 * 2. **role**: the default an admin set for a role the member holds.
 * 3. **org**: the organization's default dashboard (`isDefault`), which
 *    always exists (the server creates "Home" on first read).
 *
 * A layer whose dashboard the member can no longer open (it was unshared
 * from them after the default was set) is skipped, not an error: the member
 * still lands somewhere, and the response says which layer was passed over so
 * the interface can explain it.
 *
 * A member holds one role today. The resolver still takes a list, so a future
 * where membership carries several (directory groups mapped to roles) stays
 * deterministic: see {@link compareRoleDefaults}.
 *
 * Pure so the precedence is unit-tested in one place; the server
 * (`web/src/services/default-dashboards.ts`) does the reads and visibility
 * checks and calls this.
 */

export type DefaultDashboardSource = "user" | "role" | "org";

/** A role's default dashboard, as the role-defaults settings list shows it. */
export interface RoleDefaultDashboard {
  roleId: string;
  roleName: string;
  isSystem: boolean;
  /** `owner` | `admin` | `member` for system roles, null for custom roles. */
  systemKey: string | null;
  /** Null when the role has no default (its members fall through to the org default). */
  dashboardId: string | null;
}

/** `GET /api/org/:orgId/dashboards/default`. */
export interface DefaultDashboardResolution {
  /** The dashboard the caller lands on. */
  dashboardId: string;
  dashboardName: string;
  /** Which layer it came from. */
  source: DefaultDashboardSource;
  /** The caller's own pick, whether or not it could be used. Null when unset. */
  userDefaultDashboardId: string | null;
  /**
   * The role default that applies to the caller (the one used, or the first
   * one considered when none could be), null when no role of theirs has one.
   */
  roleDefault: { roleId: string; roleName: string; dashboardId: string } | null;
  /** The organization default, the final fallback. */
  orgDefaultDashboardId: string;
  /**
   * Layers that were set but skipped because the caller cannot open the
   * dashboard any more. The interface uses this to say "your default is no
   * longer shared with you" rather than silently showing something else.
   */
  skipped: Array<Exclude<DefaultDashboardSource, "org">>;
}

/** `PUT /api/org/:orgId/dashboards/default/me` body. */
export interface SetMyDefaultDashboardInput {
  dashboardId: string;
}

/** `PUT /api/org/:orgId/dashboards/role-defaults/:roleId` body. */
export interface SetRoleDefaultDashboardInput {
  dashboardId: string;
}

const SYSTEM_ROLE_RANK: Record<string, number> = { owner: 0, admin: 1, member: 2 };

/**
 * Order in which a member's roles' defaults are tried, when they hold more
 * than one:
 *
 * 1. custom roles before system roles: a custom role is a deliberate,
 *    narrower grouping ("Finance"), and its default is the more specific
 *    statement about where those people should land;
 * 2. among system roles, owner, then admin, then member;
 * 3. then by role name, then by role id, so the answer never depends on the
 *    order rows came back from the database.
 */
export function compareRoleDefaults(
  a: Pick<RoleDefaultDashboard, "roleId" | "roleName" | "isSystem" | "systemKey">,
  b: Pick<RoleDefaultDashboard, "roleId" | "roleName" | "isSystem" | "systemKey">,
): number {
  if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
  if (a.isSystem && b.isSystem) {
    const ra = SYSTEM_ROLE_RANK[a.systemKey ?? ""] ?? 99;
    const rb = SYSTEM_ROLE_RANK[b.systemKey ?? ""] ?? 99;
    if (ra !== rb) return ra - rb;
  }
  if (a.roleName !== b.roleName) return a.roleName < b.roleName ? -1 : 1;
  if (a.roleId !== b.roleId) return a.roleId < b.roleId ? -1 : 1;
  return 0;
}

export interface DefaultDashboardCandidates {
  userDefaultDashboardId: string | null;
  /** Every role the member holds, with or without a default. */
  roles: readonly RoleDefaultDashboard[];
  orgDefaultDashboardId: string;
}

export type DefaultDashboardChoice = Omit<DefaultDashboardResolution, "dashboardName">;

/**
 * Apply the precedence. `canOpen` says whether the member can open a
 * dashboard (it exists, is not deleted, and its sharing lets them view it).
 * The org default is returned even when `canOpen` rejects it: it is the last
 * resort, and the route answering for it reports the access problem itself.
 */
export function chooseDefaultDashboard(
  candidates: DefaultDashboardCandidates,
  canOpen: (dashboardId: string) => boolean,
): DefaultDashboardChoice {
  const skipped: DefaultDashboardChoice["skipped"] = [];
  const base = {
    userDefaultDashboardId: candidates.userDefaultDashboardId,
    orgDefaultDashboardId: candidates.orgDefaultDashboardId,
  };

  const ordered = candidates.roles
    .filter((r): r is RoleDefaultDashboard & { dashboardId: string } => r.dashboardId !== null)
    .slice()
    .sort(compareRoleDefaults);
  const first = ordered[0];
  const usableRole = ordered.find((r) => canOpen(r.dashboardId)) ?? null;
  const shownRole = usableRole ?? first ?? null;
  const roleDefault = shownRole
    ? { roleId: shownRole.roleId, roleName: shownRole.roleName, dashboardId: shownRole.dashboardId }
    : null;

  if (candidates.userDefaultDashboardId) {
    if (canOpen(candidates.userDefaultDashboardId)) {
      return {
        ...base,
        dashboardId: candidates.userDefaultDashboardId,
        source: "user",
        roleDefault,
        skipped,
      };
    }
    skipped.push("user");
  }

  if (usableRole) {
    return { ...base, dashboardId: usableRole.dashboardId, source: "role", roleDefault, skipped };
  }
  if (first) skipped.push("role");

  return {
    ...base,
    dashboardId: candidates.orgDefaultDashboardId,
    source: "org",
    roleDefault,
    skipped,
  };
}
