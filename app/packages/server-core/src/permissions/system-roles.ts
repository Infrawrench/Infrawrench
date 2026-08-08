import { ALL_PERMISSIONS } from "./catalog";

export type SystemRoleKey = "owner" | "admin" | "member";

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: readonly string[];
}

const ALL = [...ALL_PERMISSIONS];
const ALL_EXCEPT = (...exclude: readonly string[]) => ALL.filter((p) => !exclude.includes(p));

export const SYSTEM_ROLE_DEFINITIONS: Record<SystemRoleKey, SystemRoleDefinition> = {
  owner: {
    key: "owner",
    name: "Owner",
    description: "Full access to everything in the organization, including billing and deletion.",
    permissions: ["*"],
  },
  admin: {
    key: "admin",
    name: "Admin",
    description:
      "Manage accounts, resources, team members, and API keys. Cannot manage billing or delete the organization.",
    permissions: ALL_EXCEPT("billing:write", "org:settings:write"),
  },
  member: {
    key: "member",
    name: "Member",
    description:
      "View and connect to resources. Cannot create or delete accounts and resources, manage team, or change billing.",
    permissions: [
      "accounts:read",
      "resources:read",
      "resources:execute",
      "secrets:read",
      "storage:read",
      "dashboards:read",
      "dashboards:write",
      // Workflows used to ride on `dashboards:*`, so members have always been
      // able to write, run, and approve them. All three land here to keep that
      // exactly as it was — carving `workflows:approve` out of the default
      // would silently 403 members who approve today. The split earns its keep
      // through custom roles: withholding `workflows:approve` from the authors
      // is now expressible, which is the whole point of an approval gate.
      "workflows:read",
      "workflows:write",
      "workflows:approve",
      // Three levels, because previewing and shipping are genuinely different
      // risks. `read` is the history and the declared environments — inert.
      // `plan` runs the repo's plan() against the org's host, so it IS code
      // execution, but it builds nothing and ships nothing; members get it so
      // they can see what a deploy would do. `write` actually builds and ships,
      // and stays with admins and owners.
      //
      // Splitting them is what makes the middle case expressible at all: a
      // custom role can now withhold `plan` from members without also taking
      // away the deploy history.
      "deployments:read",
      "deployments:plan",
      "costs:read",
      "budgets:read",
      "metric-alerts:read",
      // Members can see freeze windows (the banner needs the status), but
      // declaring, ending, and overriding freezes stays with admins/owners.
      "freezes:read",
      "team:read",
      "audit:read",
      // Members are exactly who break-glass is for: ask for what you need,
      // when you need it, instead of being made an admin so you never have to
      // ask. Reading the queue comes with it — an elevation regime nobody can
      // see is not a control. Deciding (`access:approve`) does not.
      "access:read",
      "access:request",
      "ssh-keys:read",
      "bastions:read",
      "billing:read",
      // Chat was never gated for session callers, so members have always had
      // it in practice; these were missing from this list rather than
      // deliberately withheld. Listing them keeps that behaviour now that
      // `authenticateChat` actually enforces the permission — and makes the
      // restriction expressible: a custom role that omits `chat:*` now blocks
      // chat instead of being silently ignored.
      "chat:read",
      "chat:write",
      // Read only, matching the other `:read`-for-members entries above and the
      // way `pages:write` is withheld. Members need this so a findings list can
      // show them "already filed as OPS-412" — without it the marker would be
      // invisible to exactly the people most likely to file a duplicate. Filing
      // itself stays with admins/owners because it writes into a third-party
      // tracker under the org's single shared Atlassian credential and cannot be
      // undone from Infrawrench; an org that wants members filing grants
      // `jira:write` through a custom role.
      "jira:read",
    ],
  },
};

export function isSystemRoleKey(key: string | null | undefined): key is SystemRoleKey {
  return key === "owner" || key === "admin" || key === "member";
}

/** Returns the in-code permission set for a system role, or null if the key is unknown. */
export function systemRolePermissions(key: string | null | undefined): readonly string[] | null {
  if (!isSystemRoleKey(key)) return null;
  return SYSTEM_ROLE_DEFINITIONS[key].permissions;
}
