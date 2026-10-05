/**
 * Enterprise single sign-on: the platform-neutral contract. Server side is the
 * org-scoped `/api/org/:orgId/sso/*` routes (web `api/routes/sso.ts`), the
 * WorkOS webhook at `/api/v1/webhooks/workos`, and the enforcement gate in
 * front of the whole org tree (`services/sso/enforcement.ts`).
 *
 * The IdP side (the SAML or OIDC connection, the SCIM directory) is configured
 * by the customer's IT admin in the WorkOS Admin Portal, reached through a
 * short-lived link this API mints. Infrawrench holds what WorkOS cannot know:
 * which role a directory group means, and who may sign in without SSO when
 * the IdP is down.
 */

/** Admin Portal flows an owner can hand to their IT admin. */
export const SSO_PORTAL_INTENTS = ["sso", "dsync", "domain_verification"] as const;
export type SsoPortalIntent = (typeof SSO_PORTAL_INTENTS)[number];

export interface SsoDomain {
  id: string;
  domain: string;
  /** `verified`, `pending` or `failed`. Only verified domains are enforced or provisioned. */
  state: string;
  verificationStrategy: string;
  /** DNS TXT record name to create for a pending DNS verification. */
  verificationPrefix: string | null;
  /** DNS TXT record value to create for a pending DNS verification. */
  verificationToken: string | null;
}

export interface SsoConnection {
  id: string;
  name: string;
  /** WorkOS connection type, e.g. `OktaSAML`, `AzureSAML`, `GenericOIDC`. */
  type: string;
  /** `active` once the IdP has completed setup; `draft`, `inactive`, `validating` otherwise. */
  state: string;
}

export interface SsoDirectory {
  id: string;
  name: string;
  /** WorkOS directory type, e.g. `okta scim v2.0`, `azure scim v2.0`, `gsuite directory`. */
  type: string;
  state: string;
}

export interface SsoSettings {
  enforceSso: boolean;
  breakGlassUserIds: string[];
  provisioningEnabled: boolean;
  defaultRoleId: string | null;
  autoAddSeats: boolean;
  updatedAt: string;
}

export interface SsoGroupRoleMapping {
  id: string;
  directoryGroupId: string;
  groupName: string;
  roleId: string;
  roleName: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Why the caller's own session does or does not satisfy enforcement, so the
 * page can say "you are signed in with SSO" before an owner turns it on.
 */
export type SsoSessionState =
  "sso" | "not_sso" | "outside_domains" | "break_glass_owner" | "unknown";

export interface SsoStatus {
  /** False on a plan without enterprise SSO: everything else is then empty. */
  planIncluded: boolean;
  /** Whether a WorkOS organization has been created for this org. */
  configured: boolean;
  settings: SsoSettings | null;
  domains: SsoDomain[];
  connections: SsoConnection[];
  directories: SsoDirectory[];
  /** Set when WorkOS could not be reached; the saved settings are still returned. */
  workosError: string | null;
  /** Owners, for the break-glass picker. */
  owners: Array<{ userId: string; email: string; displayName: string | null }>;
  currentSession: SsoSessionState;
  directoryMemberCounts: Record<string, number>;
}

export interface SsoDirectoryGroup {
  id: string;
  name: string;
  directoryId: string;
  directoryName: string;
}

export type SsoDirectoryMemberStatus =
  | "active"
  | "observed"
  | "deprovisioned"
  | "seat_limit"
  | "plan_required"
  | "domain_unverified"
  | "protected";

export interface SsoDirectoryMember {
  id: string;
  directoryId: string;
  directoryUserId: string;
  email: string;
  displayName: string | null;
  userId: string | null;
  groupIds: string[];
  status: SsoDirectoryMemberStatus;
  provisionedByDirectory: boolean;
  lastSyncedAt: string;
  deprovisionedAt: string | null;
}

export interface SsoMappingPreviewRow {
  userId: string | null;
  email: string;
  status: SsoDirectoryMemberStatus;
  currentRoleId: string | null;
  currentRoleName: string | null;
  resolvedRoleId: string | null;
  resolvedRoleName: string | null;
  source: "mapping" | "default" | "owner_unchanged";
  matchedGroupNames: string[];
  conflict: boolean;
  changes: boolean;
}

export interface SsoSyncResult {
  usersSeen: number;
  provisioned: number;
  deprovisioned: number;
  rolesChanged: number;
  skipped: number;
}

/** Payload of the structured 403 the enforcement gate answers with. */
export interface SsoRequiredPayload {
  error: string;
  code: "sso_required";
  /** Same-origin path that starts sign-in straight at the org's IdP (web). */
  signInPath: string;
  /**
   * The WorkOS organization to pass as `organization_id` on an AuthKit
   * authorize URL: how the desktop and mobile apps, which run their own PKCE
   * sign-in, start it at the org's IdP.
   */
  workosOrganizationId: string;
}

export function isSsoRequiredResponse(parsed: unknown): parsed is SsoRequiredPayload {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { code?: unknown }).code === "sso_required"
  );
}

/** Human label for a member's directory status. */
export function ssoDirectoryStatusLabel(status: SsoDirectoryMemberStatus): string {
  switch (status) {
    case "active":
      return "Member";
    case "observed":
      return "Seen (provisioning off)";
    case "deprovisioned":
      return "Removed by directory";
    case "seat_limit":
      return "Waiting for a seat";
    case "plan_required":
      return "Plan required";
    case "domain_unverified":
      return "Email outside verified domains";
    case "protected":
      return "Kept (last owner)";
  }
}
