/**
 * The page a path's `:branch` names, for every handler under
 * `/api/repos/:owner/:repo/branches/:branch`: resolved by its key
 * (`db/branch-pages.ts`), and a 404 like any missing page when there is none
 * or the text is no key at all.
 *
 * `branches.get` alone may open the page it was asked for
 * ({@link pageOrOpen}): a branch pushed before every branch had a page has
 * none, and reading it is when it gets one.
 */
import { notFound, parseBranchKey } from "@infrawrench/git-contract";
import { resolveBranchKey } from "../db/branch-pages";
import type { PullRequestWithThread } from "../db/pulls";
import { openDraftPage, opensBranchPages, titleOf } from "../events/versions";
import { RepoReaderError } from "../repo/reader";
import { agentRefOf, ownPageOnly } from "./agent-token";
import type { RepoCx } from "./context";

const NO_SUCH_PAGE = "No such branch page";

/** The page `key` names in the repository in the path, or a 404. */
export const pageOr404 = async (cx: RepoCx, key: string): Promise<PullRequestWithThread> => {
  const found = await resolveBranchKey(cx.repo.repository.id, key);
  if (!found) throw notFound(NO_SUCH_PAGE);
  // An agent's token for one branch reaches that branch's page and no other.
  ownPageOnly(cx, found);
  return found;
};

/**
 * {@link pageOr404}, except that a branch of this repository with no page
 * at all gets one now: a bare name, a branch that exists with commits the
 * default branch does not have, in a repository that opens pages (not a
 * fork, not archived). It is opened and announced as a push opens one, with
 * the reader as its author when signed in. The caller has already passed
 * the repository's read gate, so a private repository answers as missing
 * before anything here runs.
 */
export const pageOrOpen = async (cx: RepoCx, key: string): Promise<PullRequestWithThread> => {
  // An agent's token reads its own branch's page and opens none.
  if (agentRefOf(cx.principal) !== null) return pageOr404(cx, key);
  const found = await resolveBranchKey(cx.repo.repository.id, key);
  if (found) return found;
  const parsed = parseBranchKey(key);
  const { repository } = cx.repo;
  if (
    !parsed ||
    parsed.fork !== null ||
    parsed.ordinal !== null ||
    parsed.branch === repository.defaultBranch ||
    !opensBranchPages(cx.repo)
  ) {
    throw notFound(NO_SUCH_PAGE);
  }
  const branch = parsed.branch;
  let opened: PullRequestWithThread | null = null;
  try {
    const head = await cx.git.getBranch(branch);
    if (!head) throw notFound(NO_SUCH_PAGE);
    const comparison = await cx.git.compare({
      base: repository.defaultBranch,
      head: head.commit.oid,
    });
    if (comparison.ahead === 0) throw notFound(NO_SUCH_PAGE);
    // One commit of its own names the work, as on a push; otherwise the branch's name does.
    const subject = comparison.ahead === 1 ? (comparison.commits[0]?.summary.trim() ?? "") : "";
    opened = await openDraftPage({
      repo: cx.repo,
      reader: cx.git,
      branch,
      headOid: head.commit.oid,
      comparison,
      title: subject === "" ? titleOf(branch, null) : subject.slice(0, 256),
      authorUserId: cx.userId,
      actor: cx.username,
      onlyFirst: true,
    });
  } catch (error) {
    // The storage is away: the branch cannot be read, so there is no page to show yet.
    if (error instanceof RepoReaderError) throw notFound(NO_SUCH_PAGE);
    throw error;
  }
  // Opened by another request between the two reads: that one is the page.
  return opened ?? pageOr404(cx, key);
};
