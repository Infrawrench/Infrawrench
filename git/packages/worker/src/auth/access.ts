/**
 * Access resolution: `repoAccess(principal, repo) -> none | read | triage |
 * write | admin`, the one function HTTP, SSH and the API all ask
 * (git/README.md "Identity, namespaces, access").
 *
 * The decision itself ({@link decideRepoAccess}) is pure: it takes the two
 * facts that live in Postgres (the person's permissions in the owning
 * organisation, and their collaborator role) as arguments. `makeRepoAccess`
 * binds it to whatever loads those facts; `./repo-access.ts` binds the real
 * loaders. Nothing in this file touches the database, so the rules are
 * tested without one. Its one runtime import is the app's permission matcher,
 * which is pure.
 *
 * The rules, in order:
 *
 * 1. What the principal has in its own right:
 *    - a person owns their own namespace's repositories (`admin`);
 *    - in an organisation's namespace, `git:admin`, `git:write` and
 *      `git:read` give `admin`, `write` and `read`;
 *    - a collaborator role gives its level; the highest of these wins;
 *    - an API key gets what its permissions give, in its organisation only;
 *    - a deploy key and a job token get `read` or `write` on their one
 *      repository and nothing anywhere else; a job token bound to a
 *      Terraform workspace gets nothing of the repository at all.
 * 2. A personal access token never exceeds its scopes: `repo:write` caps it
 *    at `write`, `repo:read` at `read`, neither at `none`. Settings are
 *    never reachable with a token.
 * 3. A public repository is readable by everyone, whoever or whatever they
 *    are: the result is at least `read`.
 * 4. An archived repository is read-only for everyone: the result is at
 *    most `read`. `unarchived` keeps the answer before this step, which is
 *    what "may this person unarchive or delete it" asks.
 */
import type { GitRepoRole, GitVisibility } from "@infrawrench/server-core/db/schema";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import type { Principal } from "./principal";

export type RepoAccess = "none" | GitRepoRole;

export const ACCESS_ORDER: readonly RepoAccess[] = ["none", "read", "triage", "write", "admin"];

const rank = (level: RepoAccess): number => ACCESS_ORDER.indexOf(level);

export const maxAccess = (a: RepoAccess, b: RepoAccess): RepoAccess => (rank(a) >= rank(b) ? a : b);
export const minAccess = (a: RepoAccess, b: RepoAccess): RepoAccess => (rank(a) <= rank(b) ? a : b);

/** Whether `have` is at least `need`. */
export const hasAccess = (have: RepoAccess, need: RepoAccess): boolean => rank(have) >= rank(need);

/** The part of a repository the decision reads. */
export interface RepoForAccess {
  readonly id: string;
  readonly visibility: GitVisibility;
  readonly archived: boolean;
  readonly owner:
    | { readonly kind: "user"; readonly userId: string }
    | { readonly kind: "org"; readonly organizationId: string };
}

/** What Postgres knows about a person and a repository. */
export interface RepoAccessFacts {
  /**
   * The person's effective permissions in the organisation that owns the
   * repository. Empty when they are not a member, and for a user's namespace.
   */
  readonly orgPermissions: readonly string[];
  /** Their `git_collaborators` role on the repository, if they have one. */
  readonly collaboratorRole: GitRepoRole | null;
}

export const NO_FACTS: RepoAccessFacts = { orgPermissions: [], collaboratorRole: null };

/**
 * Whether a granted permission covers `required`: the app's own matcher
 * (`*` is everything, and a `*` segment is any one segment).
 */
export type PermissionMatcher = (granted: readonly string[], required: string) => boolean;

export const matchesPermission: PermissionMatcher = hasPermission;

/** What `git:*` permissions amount to on a repository of the organisation. */
export const accessFromPermissions = (
  permissions: readonly string[],
  matches: PermissionMatcher = matchesPermission,
): RepoAccess => {
  if (matches(permissions, "git:admin")) return "admin";
  if (matches(permissions, "git:write")) return "write";
  if (matches(permissions, "git:read")) return "read";
  return "none";
};

export interface RepoAccessDecision {
  /** The answer: what the principal may do to the repository now. */
  readonly access: RepoAccess;
  /**
   * The answer were the repository not archived. Only settings ask this: an
   * administrator of an archived repository must still be able to see its
   * settings, unarchive it and delete it.
   */
  readonly unarchived: RepoAccess;
}

const ownAccess = (
  principal: Principal,
  repo: RepoForAccess,
  facts: RepoAccessFacts,
  matches: PermissionMatcher,
): RepoAccess => {
  switch (principal.kind) {
    case "anonymous":
      return "none";
    case "user": {
      const owner: RepoAccess =
        repo.owner.kind === "user" && repo.owner.userId === principal.userId ? "admin" : "none";
      const organization: RepoAccess =
        repo.owner.kind === "org" ? accessFromPermissions(facts.orgPermissions, matches) : "none";
      const level = maxAccess(maxAccess(owner, organization), facts.collaboratorRole ?? "none");
      if (principal.scopes === null) return level;
      const cap: RepoAccess = principal.scopes.includes("repo:write")
        ? "write"
        : principal.scopes.includes("repo:read")
          ? "read"
          : "none";
      return minAccess(level, cap);
    }
    case "api-key":
      return repo.owner.kind === "org" && repo.owner.organizationId === principal.organizationId
        ? accessFromPermissions(principal.permissions, matches)
        : "none";
    case "deploy-key":
      if (principal.repositoryId !== repo.id) return "none";
      return principal.readOnly ? "read" : "write";
    case "job":
      if (principal.repositoryId !== repo.id) return "none";
      // Bound to a Terraform workspace: its `write` is the state's, never the repository's.
      if (principal.workspaceId != null) return "none";
      return principal.write ? "write" : "read";
  }
};

/** The decision, from the principal, the repository and the loaded facts. */
export const decideRepoAccess = (
  principal: Principal,
  repo: RepoForAccess,
  facts: RepoAccessFacts = NO_FACTS,
  matches: PermissionMatcher = matchesPermission,
): RepoAccessDecision => {
  const own = ownAccess(principal, repo, facts, matches);
  const unarchived = repo.visibility === "public" ? maxAccess(own, "read") : own;
  return { access: repo.archived ? minAccess(unarchived, "read") : unarchived, unarchived };
};

/** Where the two facts come from. */
export interface RepoAccessLoaders {
  /**
   * A person's effective permissions in an organisation; empty for a
   * non-member. `withElevation` is true for a session and false for a token
   * or an SSH key: a break-glass grant is handed to a person at a keyboard,
   * not to the unattended credentials they minted earlier.
   */
  orgPermissions(
    organizationId: string,
    userId: string,
    options: { readonly withElevation: boolean },
  ): Promise<readonly string[]>;
  collaboratorRole(repositoryId: string, userId: string): Promise<GitRepoRole | null>;
}

/** Load only what the decision will read for this principal and repository. */
export const loadRepoAccessFacts = async (
  principal: Principal,
  repo: RepoForAccess,
  loaders: RepoAccessLoaders,
): Promise<RepoAccessFacts> => {
  if (principal.kind !== "user") return NO_FACTS;
  // Their own repository: `admin` already, nothing to look up.
  if (repo.owner.kind === "user" && repo.owner.userId === principal.userId) return NO_FACTS;
  const [orgPermissions, collaboratorRole] = await Promise.all([
    repo.owner.kind === "org"
      ? loaders.orgPermissions(repo.owner.organizationId, principal.userId, {
          withElevation: principal.via === "session",
        })
      : Promise.resolve<readonly string[]>([]),
    loaders.collaboratorRole(repo.id, principal.userId),
  ]);
  return { orgPermissions, collaboratorRole };
};

export interface RepoAccessResolver {
  /** `repoAccess(principal, repo)`. */
  (principal: Principal, repo: RepoForAccess): Promise<RepoAccess>;
  /** The same, with the answer before the archive cap beside it. */
  detail(principal: Principal, repo: RepoForAccess): Promise<RepoAccessDecision>;
}

export const makeRepoAccess = (
  loaders: RepoAccessLoaders,
  matches: PermissionMatcher = matchesPermission,
): RepoAccessResolver => {
  const detail = async (principal: Principal, repo: RepoForAccess) =>
    decideRepoAccess(principal, repo, await loadRepoAccessFacts(principal, repo, loaders), matches);
  const resolve = async (principal: Principal, repo: RepoForAccess) =>
    (await detail(principal, repo)).access;
  return Object.assign(resolve, { detail });
};
