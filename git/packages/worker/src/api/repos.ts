/**
 * Other repositories a request names beside the one in its path: a pull
 * request's head, a comparison's fork. They get the same answer the path
 * would: one the caller cannot read does not exist.
 *
 * A head in another repository is also where the base repository copies
 * commits from (`RepoReader.compare`, `setPullRef`), and a pull request keeps
 * following its head branch after it is opened (the queue consumer). So the
 * caller being able to read the head is not enough: the head must be in the
 * base's fork network, and its commits must not reach people the head
 * repository would not show them to ({@link mayProposeTo}).
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

/**
 * Whether commits of `head` may be copied into `base` and shown there: the
 * head is public, or it is private and so is the base, in the same
 * namespace. A private repository's commits never land where a reader of the
 * base who cannot read the head would see them, whoever asks.
 */
export const mayProposeTo = (base: RepositoryWithOwner, head: RepositoryWithOwner): boolean =>
  base.repository.id === head.repository.id ||
  head.repository.visibility === "public" ||
  (base.repository.visibility === "private" &&
    base.repository.namespaceId === head.repository.namespaceId);

/**
 * Whether a pull request's new head queues Terraform plans in its base. Only
 * when the head is a branch of the base itself: a plan runs the head's code
 * with the workspace's lent accounts and its state, and a fork's author (or a
 * fork that is gone) is not someone the base's administrators lent them to.
 */
export const plansPullRequest = (
  baseRepositoryId: string,
  headRepositoryId: string | null,
): boolean => headRepositoryId !== null && headRepositoryId === baseRepositoryId;

/** How far up `forkOfId` is followed. Forks of forks this deep are not expected. */
const MAX_FORK_DEPTH = 16;

/** The repository a fork network starts from: the oldest ancestor still there. */
export const forkNetworkRoot = async (
  repo: RepositoryWithOwner,
  load: (id: string) => Promise<RepositoryWithOwner | null> = getRepositoryById,
): Promise<string> => {
  let current = repo;
  const seen = new Set([repo.repository.id]);
  for (let depth = 0; depth < MAX_FORK_DEPTH; depth++) {
    const parentId = current.repository.forkOfId;
    if (!parentId || seen.has(parentId)) break;
    const parent = await load(parentId);
    if (!parent) break;
    seen.add(parentId);
    current = parent;
  }
  return current.repository.id;
};

/** Whether two repositories are one, or forks of a common one. */
export const inSameForkNetwork = async (
  a: RepositoryWithOwner,
  b: RepositoryWithOwner,
  load: (id: string) => Promise<RepositoryWithOwner | null> = getRepositoryById,
): Promise<boolean> =>
  a.repository.id === b.repository.id ||
  (await forkNetworkRoot(a, load)) === (await forkNetworkRoot(b, load));

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

/**
 * `owner/name` as the head of a comparison or a pull request into the
 * repository in the path: one the caller can read, in the same fork network,
 * whose commits the base may show ({@link mayProposeTo}). 422 otherwise.
 */
export const headRepository = async (
  cx: RepoCx,
  fullName: string,
  load: (id: string) => Promise<RepositoryWithOwner | null> = getRepositoryById,
): Promise<RepositoryWithOwner> => {
  const head = await otherRepository(cx, fullName);
  if (head === cx.repo) return head;
  if (!(await inSameForkNetwork(cx.repo, head, load))) {
    throw unprocessable("That repository is not a fork of this one", "ref_not_found");
  }
  if (!mayProposeTo(cx.repo, head)) {
    throw unprocessable(
      "A private repository's branches can only be compared with a private repository of the same owner",
    );
  }
  return head;
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
