/**
 * What a push to a branch leaves for review: its version copied from the
 * repository's Durable Object, the branch's page opened when it has none,
 * and the review comments carried to the new version.
 *
 * The Durable Object numbered the version in the transaction that moved the
 * branch (`repo/do/versions.ts`). This copies every version of the branch
 * that Postgres does not have yet, not only the one the event names, so a
 * push whose event was lost is recorded by the next one. Every step is safe
 * to repeat: a version is unique on its numbers, a branch page is opened
 * only for a lineage with no pull request, and a comment already at the new
 * head is left alone.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Commit } from "@infrawrench/git-contract";
import {
  gitBranchVersions,
  gitIssues,
  gitPullRequests,
  gitReviewComments,
} from "@infrawrench/server-core/db/schema";
import { locatorOf } from "../api/context";
import { mayProposeTo, plansPullRequest } from "../api/repos";
import { db } from "../db/client";
import { type PullRequestWithThread, createPullRequestIn, reanchorThread } from "../db/pulls";
import { settleAnswered } from "../db/instructions";
import { type RepositoryWithOwner, getRepositoryById } from "../db/repositories";
import {
  type VersionRow,
  claimTraceEntries,
  getAgentLink,
  insertVersion,
  keepLineage,
  latestVersionOf,
  linkVersionsToPull,
  markBranchForPruning,
  versionsForPull,
} from "../db/review";
import type { GitPushEvent } from "../env";
import {
  type LineAnchor,
  type ReaderComparison,
  type RepoReader,
  RepoReaderError,
} from "../repo/reader";
import { announcePullRequest } from "./ci";
import type { PushContext } from "./consumer";
import { queuePullRequestPlans, scanAhead } from "./terraform";

type Update = GitPushEvent["updates"][number];

const ZERO = /^0+$/;

const tryRead = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof RepoReaderError) return null;
    throw error;
  }
};

/** A deleted branch's versions are kept thirty days from the deletion. */
export const branchDeleted = (cx: PushContext, branch: string): Promise<void> =>
  markBranchForPruning(cx.repo.repository.id, branch, new Date(cx.event.at));

/**
 * Copies the branch's versions that are not in Postgres yet, oldest first,
 * and answers the ones this call copied. `heads` are the open pull requests
 * whose head is the branch; the first is the one a version belongs to and
 * is measured against.
 */
export const recordVersions = async (
  cx: PushContext,
  update: Update,
  branch: string,
  heads: readonly PullRequestWithThread[],
): Promise<VersionRow[]> => {
  const { repository } = cx.repo;
  if (branch === repository.defaultBranch) return [];
  const latest = await latestVersionOf(repository.id, branch);
  const stored = await tryRead(() =>
    cx.reader.listVersions({
      branch,
      after: latest ? { lineage: latest.lineage, number: latest.number } : undefined,
    }),
  );
  // The storage is away: the next push to the branch copies what this one could not.
  if (!stored || stored.length === 0) return [];

  let owner = heads[0] ?? null;
  let base =
    owner === null || owner.pull.repositoryId === repository.id
      ? cx.repo
      : await getRepositoryById(owner.pull.repositoryId);
  // A fork that may no longer be proposed to its base is measured against itself, like a branch with no page.
  if (base === null || (base !== cx.repo && !mayProposeTo(base, cx.repo))) {
    owner = null;
    base = cx.repo;
  }
  const fork = base.repository.id !== repository.id;
  const targetRef = owner?.pull.baseRef ?? repository.defaultBranch;
  const target = base;
  const reader = target === cx.repo ? cx.reader : cx.readers(cx.env, locatorOf(target));
  const agent = owner ? await getAgentLink(owner.pull.issueId) : null;

  const copied: VersionRow[] = [];
  for (const version of stored) {
    // The whole change at this version, when the storage can say.
    const comparison = await tryRead(() =>
      reader.compare({
        base: targetRef,
        head: version.tipOid,
        headRepositoryId: fork ? repository.id : undefined,
      }),
    );
    // The event names one push; a version copied late has no one to name.
    const pushed =
      version.tipOid === update.newOid &&
      (version.previousOid ?? "") === (ZERO.test(update.oldOid) ? "" : update.oldOid);
    const row = await insertVersion({
      repositoryId: repository.id,
      branch,
      lineage: version.lineage,
      number: version.number,
      tipOid: version.tipOid,
      baseOid: comparison?.mergeBaseOid ?? null,
      targetRef,
      previousOid: version.previousOid,
      forced: version.forced,
      pusherUserId: pushed ? cx.userId : null,
      pusherKind: pushed ? (cx.event.actor?.kind ?? null) : null,
      agent: agent && pushed ? { kind: agent.kind, name: agent.displayName } : null,
      pullRequestId: owner?.pull.issueId ?? null,
      commitsCount: comparison?.ahead ?? null,
      additions: comparison?.stats.additions ?? null,
      deletions: comparison?.stats.deletions ?? null,
      changedFiles: comparison?.stats.filesChanged ?? null,
      createdAt: new Date(version.at),
    });
    if (!row) continue;
    copied.push(row);
    await keepLineage(repository.id, branch, row.lineage, row.createdAt);
    await claimTraceEntries(row);
    // What the agent said its next push would answer, this version answers.
    await settleAnswered(row);
  }
  return copied;
};

/** The branch's name as a title, when no single commit names the work. */
export const titleOf = (branch: string, commits: readonly Commit[] | null): string => {
  if (commits?.length === 1) {
    const subject = commits[0]!.message.split("\n", 1)[0]!.trim();
    if (subject !== "") return subject.slice(0, 256);
  }
  const words = (branch.split("/").at(-1) ?? branch).replace(/[-_]+/g, " ").trim();
  const title = words === "" ? branch : words.charAt(0).toUpperCase() + words.slice(1);
  return title.slice(0, 256);
};

/** What {@link openDraftPage} opens a page from. */
export interface DraftPage {
  readonly repo: RepositoryWithOwner;
  /** The repository's reader. */
  readonly reader: RepoReader;
  readonly branch: string;
  readonly headOid: string;
  /** The default branch to the head, as `RepoReader.compare` answered it. */
  readonly comparison: Pick<ReaderComparison, "base" | "mergeBaseOid" | "ahead" | "stats">;
  readonly title: string;
  /** The pusher, or whoever opened the page; null for nobody signed in. */
  readonly authorUserId: string | null;
  /** The username CI is told acted. */
  readonly actor: string | null;
  /**
   * Refuse when the branch has ever had a page, not only an open one: a
   * page opened on reading a branch is for branches that never had one.
   */
  readonly onlyFirst: boolean;
}

/**
 * Opens a branch's page as a draft against the default branch, and
 * announces it as an opened page (CI, and Terraform plans for a branch of
 * the repository itself). Null when the branch has an open page already
 * (or, with `onlyFirst`, any page): the check and the insert hold one
 * advisory lock per branch, so a push and a reader opening it at once open
 * one page.
 */
export const openDraftPage = async (input: DraftPage): Promise<PullRequestWithThread | null> => {
  const { repository } = input.repo;
  const created = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`git_branch_page:${repository.id}:${input.branch}`}))`,
    );
    const [existing] = await tx
      .select({ id: gitPullRequests.issueId })
      .from(gitPullRequests)
      .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
      .where(
        and(
          eq(gitPullRequests.repositoryId, repository.id),
          eq(gitPullRequests.headRepositoryId, repository.id),
          eq(gitPullRequests.headRef, input.branch),
          ...(input.onlyFirst ? [] : [eq(gitIssues.state, "open")]),
        ),
      )
      .limit(1);
    if (existing) return null;
    return createPullRequestIn(tx, {
      repositoryId: repository.id,
      title: input.title,
      body: "",
      authorUserId: input.authorUserId,
      labelIds: [],
      assigneeUserIds: [],
      milestoneId: null,
      baseRef: repository.defaultBranch,
      headRepositoryId: repository.id,
      headRef: input.branch,
      headOid: input.headOid,
      baseOid: input.comparison.base.commitOid,
      mergeBaseOid: input.comparison.mergeBaseOid,
      draft: true,
      commitsCount: input.comparison.ahead,
      additions: input.comparison.stats.additions,
      deletions: input.comparison.stats.deletions,
      changedFiles: input.comparison.stats.filesChanged,
    });
  });
  if (!created) return null;
  await linkVersionsToPull(repository.id, input.branch, created.pull.issueId);
  await tryRead(() =>
    input.reader.setPullRef({
      number: created.thread.number,
      headRepositoryId: repository.id,
      oid: input.headOid,
    }),
  );
  await announcePullRequest(input.repo, created, "opened", input.repo, input.actor);
  await scanAhead(input.reader, repository.id, [input.headOid, input.comparison.mergeBaseOid]);
  if (plansPullRequest(repository.id, created.pull.headRepositoryId)) {
    await queuePullRequestPlans({
      repositoryId: repository.id,
      organizationId: input.repo.owner.organizationId,
      defaultBranch: repository.defaultBranch,
      baseRef: created.pull.baseRef,
      headRef: input.branch,
      headOid: input.headOid,
      pullNumber: created.thread.number,
      userId: input.authorUserId,
      fromFork: false,
      reader: input.reader,
      headRepositoryId: undefined,
    });
  }
  return created;
};

/**
 * Whether a repository opens pages for its branches: not a fork (its
 * branches are proposed to its parent, by a person) and not an archived one.
 */
export const opensBranchPages = ({ repository }: RepositoryWithOwner): boolean =>
  !repository.isFork && !repository.archived;

/**
 * Opens the branch's page: a draft against the default branch, the first
 * time a branch is pushed. Not for a fork or an archived repository, not for
 * the default branch, not when a page for the lineage exists or ever did,
 * and not for a branch with nothing of its own.
 */
export const openBranchPage = async (
  cx: PushContext,
  update: Update,
  branch: string,
  copied: readonly VersionRow[],
  commits: readonly Commit[] | null,
): Promise<PullRequestWithThread | null> => {
  const { repository } = cx.repo;
  const newest = copied.at(-1);
  if (!newest || newest.tipOid !== update.newOid) return null;
  if (!opensBranchPages(cx.repo)) return null;
  if (branch === repository.defaultBranch) return null;
  // Any version of the lineage that belongs to a page: the page was opened before.
  const [paged] = await db
    .select({ id: gitBranchVersions.id })
    .from(gitBranchVersions)
    .where(
      and(
        eq(gitBranchVersions.repositoryId, repository.id),
        eq(gitBranchVersions.branch, branch),
        eq(gitBranchVersions.lineage, newest.lineage),
        isNotNull(gitBranchVersions.pullRequestId),
      ),
    )
    .limit(1);
  if (paged) return null;
  const comparison = await tryRead(() =>
    cx.reader.compare({ base: repository.defaultBranch, head: update.newOid }),
  );
  // Without the storage there is nothing to open it with; the next push tries again.
  if (!comparison || comparison.ahead === 0) return null;
  return openDraftPage({
    repo: cx.repo,
    reader: cx.reader,
    branch,
    headOid: update.newOid,
    comparison,
    title: titleOf(branch, commits),
    authorUserId: cx.userId,
    actor: cx.username,
    onlyFirst: false,
  });
};

/**
 * Carries a pull request's review threads to its new head. A thread whose
 * lines stand in the new version moves to their new numbers and shows on
 * every later version; one whose lines changed is answered by this version
 * (`answeredInVersion`) and stays where it was written.
 *
 * `RIGHT` anchors are lines of the head's file, compared head to head.
 * `LEFT` anchors are lines of the base's file, compared merge base to merge
 * base, which only differ after a rebase.
 */
export const carryThreads = async (
  cx: PushContext,
  found: PullRequestWithThread,
  newHeadOid: string,
): Promise<void> => {
  const { pull } = found;
  const roots = (
    await db
      .select()
      .from(gitReviewComments)
      .where(
        and(
          eq(gitReviewComments.pullRequestId, pull.issueId),
          isNull(gitReviewComments.inReplyToId),
          eq(gitReviewComments.outdated, false),
        ),
      )
  ).filter((root) => root.commitOid !== newHeadOid && root.line !== null);
  if (roots.length === 0) return;

  const versions = await versionsForPull(pull);
  // The newest version at each commit: a branch can come back to one.
  const byTip = new Map(versions.map((version) => [version.tipOid, version]));
  const next = byTip.get(newHeadOid);
  // Not copied yet (the storage was away): the next push carries them.
  if (!next) return;

  // The head's objects are in its own repository; a base that is another one may not have them all.
  const head =
    pull.headRepositoryId === cx.repo.repository.id
      ? cx.repo
      : pull.headRepositoryId
        ? await getRepositoryById(pull.headRepositoryId)
        : null;
  if (!head) return;
  const base =
    pull.repositoryId === cx.repo.repository.id
      ? cx.repo
      : await getRepositoryById(pull.repositoryId);
  if (!base || !mayProposeTo(base, head)) return;
  const reader = head === cx.repo ? cx.reader : cx.readers(cx.env, locatorOf(head));

  const groups = new Map<string, { fromOid: string; toOid: string; anchors: LineAnchor[] }>();
  const stale: string[] = [];
  for (const root of roots) {
    const from = root.side === "RIGHT" ? root.commitOid : byTip.get(root.commitOid)?.baseOid;
    const to = root.side === "RIGHT" ? newHeadOid : next.baseOid;
    // A base that was never measured cannot say where the old side's lines went.
    if (!from || !to) {
      stale.push(root.id);
      continue;
    }
    const key = `${from}:${to}`;
    const group = groups.get(key) ?? { fromOid: from, toOid: to, anchors: [] };
    group.anchors.push({
      key: root.id,
      path: root.path,
      line: root.line!,
      startLine: root.startLine,
    });
    groups.set(key, group);
  }
  for (const id of stale) await reanchorThread(id, { outdated: true, version: next.number });
  for (const group of groups.values()) {
    const mapped =
      group.fromOid === group.toOid
        ? group.anchors.map((anchor) => ({
            key: anchor.key,
            line: anchor.line,
            startLine: anchor.startLine,
          }))
        : await tryRead(() => reader.mapLines(group));
    // The storage did not answer: the threads stay where they are until the next push.
    if (!mapped) continue;
    for (const line of mapped) {
      await reanchorThread(
        line.key,
        "changed" in line
          ? { outdated: true, version: next.number }
          : {
              outdated: false,
              commitOid: newHeadOid,
              line: line.line,
              startLine: line.startLine,
            },
      );
    }
  }
};
