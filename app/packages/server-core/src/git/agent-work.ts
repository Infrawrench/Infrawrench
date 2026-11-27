/**
 * "Start work with Infrawrench": the app's side of a branch on
 * git.infrawrench.com that one of the app's agent sessions works on.
 *
 * The forge opens a branch and its page, whose description is the ask, then
 * links to the app's Agents page with `?git=<owner>/<repo>&branch=<key>`,
 * the key being the page's (client-core's `git-branch-key.ts`). Starting a
 * session from there resolves that page here (it must be an open page of a
 * repository this organisation owns, for a branch in that same repository),
 * and the session row is recorded in the forge's `git_agent_links` so the
 * page names its agent.
 *
 * The forge and the app share these tables, so this reads them rather than
 * calling the forge (CLAUDE.md, "git.infrawrench.com"). Light on purpose: no
 * plugin loader, no socket driver.
 */
import { gitBranchPagePath, parseGitBranchKey } from "@infrawrench/client-core";
import { and, asc, eq, sql } from "drizzle-orm";

import { cloneUrl, gitBaseUrl } from "../ci/source.js";
import { db } from "../db/client.js";
import {
  gitAgentLinks,
  gitIssues,
  gitNamespaces,
  gitPullRequests,
  gitRepositories,
} from "../db/schema.js";

/** What the app is asked to work on: a branch page, by its address on the forge. */
export interface GitWorkRequest {
  readonly owner: string;
  readonly repo: string;
  /** The page's key: `work/fix-login`, or `work/fix-login~2` for an earlier page of the name. */
  readonly branch: string;
}

/** A branch page an agent session may work on, resolved. */
export interface GitWork {
  readonly organizationId: string;
  readonly repositoryId: string;
  /** The page's row (`git_pull_requests.issue_id`): the agent link's key. */
  readonly pageId: string;
  /** The namespace's and the repository's names as spelled. */
  readonly owner: string;
  readonly repo: string;
  /**
   * The page's key as the forge names it: the bare branch name, since a
   * page that can be worked on is open and a branch has one open page.
   */
  readonly key: string;
  /** The branch, short (`work/fix-login`). */
  readonly branch: string;
  /** The branch's full ref name: what the session's token may push. */
  readonly ref: string;
  /** The page's title and description: the ask. */
  readonly title: string;
  readonly body: string;
  /** What the VM clones. Never carries a credential. */
  readonly cloneUrl: string;
  /** Where people review the work: the branch's page. */
  readonly pageUrl: string;
  /** The forge's origin, which its API is under (`<origin>/api/repos/...`). */
  readonly forgeOrigin: string;
}

/**
 * The one refusal for a branch page that cannot be worked on: missing, not
 * this organisation's, private and unreadable, closed, or from a fork. One
 * message for all of them, so the answer never says whether a
 * private repository exists.
 */
export class GitWorkUnavailable extends Error {
  constructor() {
    super("There is no open branch page to work on at that address.");
    this.name = "GitWorkUnavailable";
  }
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** The longest key: a fork's `owner/name:`, a branch name and an ordinal fit well inside it. */
export const MAX_BRANCH_KEY_LENGTH = 512;

/** Whether a request is shaped like a forge address at all, before anything is looked up. */
export function isGitWorkRequest(value: GitWorkRequest): boolean {
  return (
    NAME.test(value.owner) &&
    NAME.test(value.repo) &&
    typeof value.branch === "string" &&
    value.branch.length >= 1 &&
    value.branch.length <= MAX_BRANCH_KEY_LENGTH &&
    parseGitBranchKey(value.branch) !== null
  );
}

/** `refs/heads/<branch>`, for a branch name as the page stores it. */
export function branchRef(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

interface WorkRow {
  repositoryId: string;
  repositoryName: string;
  archived: boolean;
  namespaceSlug: string;
  pageId: string;
  headRepositoryId: string | null;
  headRef: string;
  number: number;
  title: string;
  body: string;
  state: string;
  isPullRequest: boolean;
}

const workColumns = {
  repositoryId: gitRepositories.id,
  repositoryName: gitRepositories.name,
  archived: gitRepositories.archived,
  namespaceSlug: gitNamespaces.slug,
  pageId: gitPullRequests.issueId,
  headRepositoryId: gitPullRequests.headRepositoryId,
  headRef: gitPullRequests.headRef,
  number: gitIssues.number,
  title: gitIssues.title,
  body: gitIssues.body,
  state: gitIssues.state,
  // The thread is a branch page's (the column keeps its name).
  isPullRequest: gitIssues.isPullRequest,
};

/** The work a row describes, or null when it is not something a session may work on. */
function toWork(organizationId: string, row: WorkRow | undefined): GitWork | null {
  if (!row) return null;
  if (!row.isPullRequest || row.state !== "open" || row.archived) return null;
  // A fork's branch is not this repository's to push, and a token for this
  // repository could not push it anyway.
  if (row.headRepositoryId !== row.repositoryId) return null;
  const branch = row.headRef.replace(/^refs\/heads\//, "");
  const source = {
    gitRepositoryId: row.repositoryId,
    repoFullName: `${row.namespaceSlug}/${row.repositoryName}`,
  };
  const forgeOrigin = gitBaseUrl();
  return {
    organizationId,
    repositoryId: row.repositoryId,
    pageId: row.pageId,
    owner: row.namespaceSlug,
    repo: row.repositoryName,
    key: branch,
    branch,
    ref: branchRef(row.headRef),
    title: row.title,
    body: row.body,
    cloneUrl: cloneUrl(source),
    pageUrl: `${forgeOrigin}${gitBranchPagePath(row.namespaceSlug, row.repositoryName, branch)}`,
    forgeOrigin,
  };
}

/**
 * The page a key's ordinal names among one branch's pages, oldest first:
 * the `n`-th for `~n`, else the open one (the newest open, should older data
 * hold two), else the newest. The forge's own rule (`branch-pages.ts` in its
 * worker), so a key names the same page in both.
 */
export function pickBranchPage<P extends { readonly state: string }>(
  pages: readonly P[],
  ordinal: number | null,
): P | undefined {
  if (ordinal !== null) return pages[ordinal - 1];
  for (let index = pages.length - 1; index >= 0; index--) {
    if (pages[index]!.state === "open") return pages[index];
  }
  return pages.at(-1);
}

/**
 * The open branch page `key` names in `owner/repo`, when this organisation
 * owns the repository and the branch is in that same repository. Throws
 * {@link GitWorkUnavailable} otherwise, the same way whatever the reason.
 *
 * A fork's page (`owner/name:branch`, `-:branch`) is never one a session may
 * work on, so such a key is refused before anything is looked up: what it
 * would resolve to is refused anyway, and the fork is not looked for.
 */
export async function resolveGitWork(
  organizationId: string,
  request: GitWorkRequest,
): Promise<GitWork> {
  if (!isGitWorkRequest(request)) throw new GitWorkUnavailable();
  const key = parseGitBranchKey(request.branch);
  if (!key || key.fork !== null) throw new GitWorkUnavailable();
  // Every page of the branch in the repository, oldest first: the key's
  // ordinal counts them.
  const pages = await db
    .select(workColumns)
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .innerJoin(gitPullRequests, eq(gitPullRequests.repositoryId, gitRepositories.id))
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      and(
        eq(gitNamespaces.slugLower, request.owner.toLowerCase()),
        eq(gitNamespaces.kind, "org"),
        eq(gitNamespaces.organizationId, organizationId),
        eq(gitRepositories.nameLower, request.repo.toLowerCase()),
        eq(gitPullRequests.headRepositoryId, gitRepositories.id),
        eq(gitPullRequests.headRef, key.branch),
      ),
    )
    .orderBy(asc(gitIssues.number));
  const work = toWork(organizationId, pickBranchPage(pages, key.ordinal));
  if (!work) throw new GitWorkUnavailable();
  return work;
}

/** The name the branch page shows for its agent. */
export const INFRAWRENCH_AGENT_DISPLAY_NAME = "Infrawrench agent";

/**
 * Names the agent session as the branch page's agent (`git_agent_links`,
 * kind `infrawrench`): the forge shows it, and setup finds the work again
 * from it ({@link gitWorkForSession}). Replaces whatever agent the page
 * named before.
 */
export async function recordAgentLink(input: {
  readonly work: GitWork;
  readonly sessionId: string;
  readonly userId: string | null;
}): Promise<void> {
  const { work, sessionId, userId } = input;
  const externalRefs = { sessionId, organizationId: work.organizationId };
  await db
    .insert(gitAgentLinks)
    .values({
      pullRequestId: work.pageId,
      repositoryId: work.repositoryId,
      kind: "infrawrench",
      displayName: INFRAWRENCH_AGENT_DISPLAY_NAME,
      externalRefs,
      t3EnvironmentId: null,
      connectedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: gitAgentLinks.pullRequestId,
      set: {
        kind: "infrawrench",
        displayName: INFRAWRENCH_AGENT_DISPLAY_NAME,
        externalRefs,
        t3EnvironmentId: null,
        connectedByUserId: userId,
        updatedAt: new Date(),
      },
    });
}

/**
 * The work an agent session was started for, looked up again from its
 * agent link: null for a session that works on no branch page, and for one
 * whose page has since closed, moved out of the organisation or named
 * another agent. Setup calls this each time it hands the VM a token, so a
 * closed page gets no new one.
 */
export async function gitWorkForSession(
  organizationId: string,
  sessionId: string,
): Promise<GitWork | null> {
  const [row] = await db
    .select(workColumns)
    .from(gitAgentLinks)
    .innerJoin(gitPullRequests, eq(gitPullRequests.issueId, gitAgentLinks.pullRequestId))
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .innerJoin(gitRepositories, eq(gitRepositories.id, gitPullRequests.repositoryId))
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(
      and(
        eq(gitAgentLinks.kind, "infrawrench"),
        sql`${gitAgentLinks.externalRefs}->>'sessionId' = ${sessionId}`,
        sql`${gitAgentLinks.externalRefs}->>'organizationId' = ${organizationId}`,
        eq(gitNamespaces.kind, "org"),
        eq(gitNamespaces.organizationId, organizationId),
      ),
    )
    .limit(1);
  return toWork(organizationId, row);
}
