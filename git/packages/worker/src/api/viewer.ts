/**
 * What a caller can see in lists: the SQL twin of `repoAccess` for a whole
 * page (`db/repositories.ts` `visibleTo`), resolved once per request.
 */
import { type RepoAccess, accessFromPermissions } from "../auth/access";
import type { Principal } from "../auth/principal";
import { type UserOrganization, listUserOrganizations, orgPermissions } from "../db/organizations";
import type { ListViewer } from "../db/repositories";

export interface ViewerOrganization extends UserOrganization {
  /** The person's effective permissions there. */
  readonly permissions: readonly string[];
  /** What those amount to on the organisation's repositories. */
  readonly access: RepoAccess;
}

export interface Viewer extends ListViewer {
  /** The person's organisations. Empty for anything that is not a person. */
  readonly organizations: readonly ViewerOrganization[];
  /** The most a personal token's scopes allow; `admin` for a session. */
  readonly cap: RepoAccess;
}

const NOBODY: Viewer = {
  userId: null,
  readableOrganizationIds: [],
  organizations: [],
  cap: "none",
};

export const resolveViewer = async (principal: Principal): Promise<Viewer> => {
  if (principal.kind === "api-key") {
    const readable = accessFromPermissions(principal.permissions) !== "none";
    return {
      ...NOBODY,
      readableOrganizationIds: readable ? [principal.organizationId] : [],
      cap: "write",
    };
  }
  if (principal.kind !== "user") return NOBODY;
  const cap: RepoAccess =
    principal.scopes === null
      ? "admin"
      : principal.scopes.includes("repo:write")
        ? "write"
        : principal.scopes.includes("repo:read")
          ? "read"
          : "none";
  // A token with no repository scope sees what a signed-out visitor does.
  if (cap === "none") return NOBODY;
  const memberships = await listUserOrganizations(principal.userId);
  const organizations: ViewerOrganization[] = [];
  for (const organization of memberships) {
    const permissions = await orgPermissions(organization.id, principal.userId, {
      withElevation: principal.via === "session",
    });
    organizations.push({
      ...organization,
      permissions,
      access: accessFromPermissions(permissions),
    });
  }
  return {
    userId: principal.userId,
    readableOrganizationIds: organizations
      .filter((organization) => organization.access !== "none")
      .map((organization) => organization.id),
    organizations,
    cap,
  };
};
