/**
 * Endpoint annotations: the gate each endpoint states, which the worker's
 * middleware enforces before a payload is decoded and the OpenAPI document
 * repeats. One vocabulary for every group.
 *
 * - {@link RequiredAccess}: the least `repoAccess` level on the repository in
 *   the path (`:owner/:repo`). `read` on a public repository lets anonymous
 *   callers through; anything above needs a credential.
 * - {@link AllowedWhenArchived}: judge `RequiredAccess` against the level the
 *   caller would have were the repository not archived. An archived
 *   repository caps everyone at `read`, so without this its administrators
 *   could neither see its settings nor unarchive it.
 * - {@link RequiresUser}: a signed-in person (a session or a personal token),
 *   on endpoints with no repository in the path.
 * - {@link RequiredOrgPermission}: an Infrawrench permission in the
 *   organisation named by `:orgId`.
 * - {@link HandlerGate}: the handler owns the rule because it depends on the
 *   object (a comment's author may edit it; so may `triage`). Documents, does
 *   not enforce.
 */
import { Context } from "effect";

export const REPO_ACCESS_LEVELS = ["none", "read", "triage", "write", "admin"] as const;
export type RepoAccessLevel = (typeof REPO_ACCESS_LEVELS)[number];

/** Whether `have` is at least `need`. */
export const accessAtLeast = (have: RepoAccessLevel, need: RepoAccessLevel): boolean =>
  REPO_ACCESS_LEVELS.indexOf(have) >= REPO_ACCESS_LEVELS.indexOf(need);

export const RequiredAccess = Context.Reference<Exclude<RepoAccessLevel, "none"> | undefined>(
  "infrawrench/git/RequiredAccess",
  { defaultValue: () => undefined },
);

export const AllowedWhenArchived = Context.Reference<boolean>(
  "infrawrench/git/AllowedWhenArchived",
  { defaultValue: () => false },
);

export const RequiresUser = Context.Reference<boolean>("infrawrench/git/RequiresUser", {
  defaultValue: () => false,
});

export const GIT_PERMISSIONS = ["git:read", "git:write", "git:admin"] as const;
export type GitPermission = (typeof GIT_PERMISSIONS)[number];

export const RequiredOrgPermission = Context.Reference<GitPermission | undefined>(
  "infrawrench/git/RequiredOrgPermission",
  { defaultValue: () => undefined },
);

export const HandlerGate = Context.Reference<string | undefined>("infrawrench/git/HandlerGate", {
  defaultValue: () => undefined,
});

/** The `error` of the 400 a request that fails its schema gets, next to the issues. */
export const InvalidRequestMessage = Context.Reference<string>(
  "infrawrench/git/InvalidRequestMessage",
  { defaultValue: () => "Invalid request" },
);

/** The description of an operation's success response. */
export const SuccessDescription = Context.Reference<string | undefined>(
  "infrawrench/git/SuccessDescription",
  { defaultValue: () => undefined },
);
