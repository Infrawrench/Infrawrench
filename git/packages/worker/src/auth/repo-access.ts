/**
 * `repoAccess`, bound to Postgres: the function every transport calls. The
 * rules are `./access.ts`; this file only says where the two facts they read
 * come from.
 *
 * Call it inside `withDb` (`db/client.ts`).
 */
import { collaboratorRole } from "../db/collaborators";
import { orgPermissions } from "../db/organizations";
import { makeRepoAccess } from "./access";

/**
 * `repoAccess(principal, repo) -> "none" | "read" | "triage" | "write" | "admin"`.
 *
 * `repoAccess.detail(principal, repo)` also answers `unarchived`, the level
 * before an archived repository's read-only cap, for the endpoints annotated
 * `AllowedWhenArchived`.
 */
export const repoAccess = makeRepoAccess({ orgPermissions, collaboratorRole });

export { type RepoAccess, type RepoAccessDecision, type RepoForAccess, hasAccess } from "./access";
