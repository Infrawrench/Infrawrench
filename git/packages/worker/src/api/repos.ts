/**
 * Other repositories a request names beside the one in its path: a pull
 * request's head, a comparison's fork. They get the same answer the path
 * would: one the caller cannot read does not exist.
 */
import { type RepoAccessLevel, unprocessable } from "@infrawrench/git-contract";
import { repoAccess } from "../auth/repo-access";
import {
  type RepositoryWithOwner,
  getRepository,
  getRepositoryById,
  toRepoForAccess,
} from "../db/repositories";
import type { Cx, RepoCx } from "./context";

/** What the caller may do to a repository that is not the one in the path. */
export const accessTo = (cx: Cx, repo: RepositoryWithOwner): Promise<RepoAccessLevel> =>
  repoAccess(cx.principal, toRepoForAccess(repo));

/** `owner/name` as a repository the caller can read. 422 otherwise: it came in a query or a payload. */
export const otherRepository = async (
  cx: RepoCx,
  fullName: string,
): Promise<RepositoryWithOwner> => {
  const [owner, name, ...rest] = fullName.split("/");
  const found = owner && name && rest.length === 0 ? await getRepository(owner, name) : null;
  if (!found) throw unprocessable("No such repository", "ref_not_found");
  if (found.repository.id === cx.repo.repository.id) return cx.repo;
  if ((await accessTo(cx, found)) === "none") {
    throw unprocessable("No such repository", "ref_not_found");
  }
  return found;
};

/** A pull request's head repository and what the caller may do to it. Null when the fork is gone. */
export const headRepositoryOf = async (
  cx: RepoCx,
  headRepositoryId: string | null,
): Promise<{ repo: RepositoryWithOwner; access: RepoAccessLevel } | null> => {
  if (headRepositoryId === null) return null;
  if (headRepositoryId === cx.repo.repository.id) return { repo: cx.repo, access: cx.access };
  const repo = await getRepositoryById(headRepositoryId);
  return repo ? { repo, access: await accessTo(cx, repo) } : null;
};
