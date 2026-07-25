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
      "costs:read",
      "budgets:read",
      "team:read",
      "audit:read",
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
