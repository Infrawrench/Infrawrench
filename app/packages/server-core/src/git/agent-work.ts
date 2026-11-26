/**
 * "Start work with Infrawrench": the app's side of a pull request on
 * git.infrawrench.com that one of the app's agent sessions works on.
 *
 * The forge opens a branch and a draft pull request whose body is the ask,
 * then links to the app's Agents page with `?git=<owner>/<repo>&pull=<n>`.
 * Starting a session from there resolves that pull request here (it must be
 * an open pull request of a repository this organisation owns, whose head
 * branch is in that same repository), and the session row is recorded in
 * the forge's `git_agent_links` so the pull request names its agent.
 *
 * The forge and the app share these tables, so this reads them rather than
 * calling the forge (CLAUDE.md, "git.infrawrench.com"). Light on purpose: no
 * plugin loader, no socket driver.
 */
import { and, eq, sql } from "drizzle-orm";

import { cloneUrl, gitBaseUrl, pullUrl } from "../ci/source.js";
import { db } from "../db/client.js";
import {
  gitAgentLinks,
  gitIssues,
  gitNamespaces,
  gitPullRequests,
  gitRepositories,
} from "../db/schema.js";
import { isGitEnabled } from "./feature-flag.js"; // git-feature-flag

/** What the app is asked to work on: a pull request, by its address on the forge. */
export interface GitWorkRequest {
  readonly owner: string;
  readonly repo: string;
  readonly pull: number;
}

/** A pull request an agent session may work on, resolved. */
export interface GitWork {
  readonly organizationId: string;
  readonly repositoryId: string;
  /** The `git_pull_requests.issue_id`: the agent link's key. */
  readonly pullRequestId: string;
  /** The namespace's and the repository's names as spelled. */
  readonly owner: string;
  readonly repo: string;
  readonly pull: number;
  /** The head branch, short (`work/fix-login`). */
  readonly branch: string;
  /** The head branch's full ref name: what the session's token may push. */
  readonly ref: string;
  /** The pull request's title and body: the ask. */
  readonly title: string;
  readonly body: string;
  /** What the VM clones. Never carries a credential. */
  readonly cloneUrl: string;
  /** Where people review the work. */
  readonly pullUrl: string;
  /** The forge's origin, which its API is under (`<origin>/api/repos/...`). */
  readonly forgeOrigin: string;
}

/**
 * The one refusal for a pull request that cannot be worked on: missing, not
 * this organisation's, private and unreadable, closed, from a fork, or Git
 * off. One message for all of them, so the answer never says whether a
 * private repository exists.
 */
export class GitWorkUnavailable extends Error {
  constructor() {
    super("There is no open pull request to work on at that address.");
    this.name = "GitWorkUnavailable";
  }
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_PULL = 2_147_483_647;

/** Whether a request is shaped like a forge address at all, before anything is looked up. */
export function isGitWorkRequest(value: GitWorkRequest): boolean {
  return (
    NAME.test(value.owner) &&
    NAME.test(value.repo) &&
    Number.isSafeInteger(value.pull) &&
    value.pull >= 1 &&
    value.pull <= MAX_PULL
  );
}

/** `refs/heads/<branch>`, for a branch name as the pull request stores it. */
export function branchRef(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

interface WorkRow {
  repositoryId: string;
  repositoryName: string;
  archived: boolean;
  namespaceSlug: string;
  pullRequestId: string;
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
  pullRequestId: gitPullRequests.issueId,
  headRepositoryId: gitPullRequests.headRepositoryId,
  headRef: gitPullRequests.headRef,
  number: gitIssues.number,
  title: gitIssues.title,
  body: gitIssues.body,
  state: gitIssues.state,
  isPullRequest: gitIssues.isPullRequest,
};

/** The work a row describes, or null when it is not something a session may work on. */
function toWork(organizationId: string, row: WorkRow | undefined): GitWork | null {
  if (!row) return null;
  if (!row.isPullRequest || row.state !== "open" || row.archived) return null;
  // A fork's branch is not this repository's to push, and a token for this
  // repository could not push it anyway.
  if (row.headRepositoryId !== row.repositoryId) return null;
  const source = {
    gitRepositoryId: row.repositoryId,
    repoFullName: `${row.namespaceSlug}/${row.repositoryName}`,
  };
  return {
    organizationId,
    repositoryId: row.repositoryId,
    pullRequestId: row.pullRequestId,
    owner: row.namespaceSlug,
    repo: row.repositoryName,
    pull: row.number,
    branch: row.headRef.replace(/^refs\/heads\//, ""),
    ref: branchRef(row.headRef),
    title: row.title,
    body: row.body,
    cloneUrl: cloneUrl(source),
    pullUrl: pullUrl(source, row.number),
    forgeOrigin: gitBaseUrl(),
  };
}

/**
 * The pull request at `owner/repo#pull`, when this organisation owns the
 * repository and the pull request is open with its head branch in that
 * repository. Throws {@link GitWorkUnavailable} otherwise, the same way
 * whatever the reason.
 */
export async function resolveGitWork(
  organizationId: string,
  request: GitWorkRequest,
): Promise<GitWork> {
  if (!isGitWorkRequest(request)) throw new GitWorkUnavailable();
  // No forge work until the organisation has Git.
  if (!(await isGitEnabled(organizationId))) throw new GitWorkUnavailable(); // git-feature-flag
  const [row] = await db
    .select(workColumns)
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .innerJoin(gitIssues, eq(gitIssues.repositoryId, gitRepositories.id))
    .innerJoin(gitPullRequests, eq(gitPullRequests.issueId, gitIssues.id))
    .where(
      and(
        eq(gitNamespaces.slugLower, request.owner.toLowerCase()),
        eq(gitNamespaces.kind, "org"),
        eq(gitNamespaces.organizationId, organizationId),
        eq(gitRepositories.nameLower, request.repo.toLowerCase()),
        eq(gitIssues.number, request.pull),
      ),
    )
    .limit(1);
  const work = toWork(organizationId, row);
  if (!work) throw new GitWorkUnavailable();
  return work;
}

/** The name the pull request shows for its agent. */
export const INFRAWRENCH_AGENT_DISPLAY_NAME = "Infrawrench agent";

/**
 * Names the agent session as the pull request's agent (`git_agent_links`,
 * kind `infrawrench`): the forge shows it, and setup finds the work again
 * from it ({@link gitWorkForSession}). Replaces whatever agent the pull
 * request named before.
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
      pullRequestId: work.pullRequestId,
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
 * agent link: null for a session that works on no pull request, and for one
 * whose pull request has since closed, moved out of the organisation or
 * named another agent. Setup calls this each time it hands the VM a token,
 * so a closed pull request gets no new one.
 */
export async function gitWorkForSession(
  organizationId: string,
  sessionId: string,
): Promise<GitWork | null> {
  // Git turned off stops handing out tokens too.
  if (!(await isGitEnabled(organizationId))) return null; // git-feature-flag
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
