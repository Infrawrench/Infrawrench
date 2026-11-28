/**
 * The consumer of `infrawrench-git-events`: what a push leaves to do once the
 * refs have moved (git/README.md "After a push").
 *
 * For each push: the repository row (`pushed_at`, size, counts); the pull
 * requests whose head or base moved (new head, timeline entry, mergeability
 * back to unknown, stale approvals dismissed); the branch's version and its
 * page (`events/versions.ts`) and the review agents' run on it
 * (`events/reviews.ts`); the issues a commit on the
 * default branch closes (`Fixes #12`) or mentions; Infrawrench CI
 * (NOTES-ci.md section 1); and the Terraform runs the push asks for.
 *
 * **Every step is safe to repeat.** A queue delivers at least once, so each
 * write is either an upsert, a compare against what is stored (a pull
 * request already at the pushed head is left alone), or deduplicated by key
 * (CI's dedupe key, one Terraform run per workspace and commit, one
 * `referenced` entry per issue and commit). A message is retried only when
 * the database is away; the storage not answering degrades a step, never
 * fails the message.
 */
import type { MessageBatch } from "@cloudflare/workers-types/index";
import { and, eq, sql } from "drizzle-orm";
import type { Commit } from "@infrawrench/git-contract";
import { gitTimelineEvents } from "@infrawrench/server-core/db/schema";
import { applyState, mentionedNumbers } from "../api/thread-edits";
import { locatorOf } from "../api/context";
import { mayProposeTo, plansPullRequest } from "../api/repos";
import { db, withDb } from "../db/client";
import { getNamespaceForUser } from "../db/namespaces";
import { listProtectedBranches, protectionFor } from "../db/policy";
import {
  type PullRequestWithThread,
  dismissStaleApprovals,
  openPullRequestsForBranch,
  syncPullRequest,
} from "../db/pulls";
import { type RepositoryWithOwner, getRepositoryById, recordPush } from "../db/repositories";
import { addTimelineEvent, getThread } from "../db/threads";
import type { Env, GitEvent, GitPushEvent } from "../env";
import { type RepoReader, RepoReaderError } from "../repo/reader";
import { type RepoReaderFactory, repoReaderFor } from "../repo/select";
import { announcePullRequest, announcePush } from "./ci";
import { queueReviewForVersion } from "./reviews";
import { queueMergeApplies, queuePullRequestPlans, scanAhead } from "./terraform";
import { settleBasePush, settleDeletedHead } from "./landed";
import { branchDeleted, carryThreads, openBranchPage, recordVersions } from "./versions";
import { describeError } from "../http/log";
import { enqueueJob } from "../jobs/consumer";
import { markMirrorsPending } from "../mirror/store";

const BRANCH = "refs/heads/";
const ZERO = /^0+$/;
/** The most commits of one push that are read for mentions and listed on a pull request. */
const MAX_COMMITS = 50;

/** What the storage says, or null when it does not answer: a step then does less, never fails. */
const tryRead = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof RepoReaderError) return null;
    throw error;
  }
};

/** `Fixes #12`, `closes: #3`, `resolved #7`: the issue numbers a commit message closes. */
export const closingNumbers = (message: string): number[] => {
  const found = new Set<number>();
  for (const match of message.matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,9})\b/gi,
  )) {
    found.add(Number(match[1]));
  }
  return [...found];
};

/** One push, and what every step of handling it reads. */
export interface PushContext {
  readonly env: Env;
  readonly repo: RepositoryWithOwner;
  readonly reader: RepoReader;
  readonly readers: RepoReaderFactory;
  readonly event: GitPushEvent;
  /** The pusher's id and username, when a person pushed. */
  readonly userId: string | null;
  readonly username: string | null;
}

type Update = GitPushEvent["updates"][number];

/** A pull request whose head branch moved: its new head, what was pushed, and everything that follows. */
const syncHead = async (
  cx: PushContext,
  found: PullRequestWithThread,
  update: Update,
  commits: readonly Commit[] | null,
): Promise<void> => {
  const { thread, pull } = found;
  const base =
    pull.repositoryId === cx.repo.repository.id
      ? cx.repo
      : await getRepositoryById(pull.repositoryId);
  if (!base) return;
  // A fork made private since its pull request was opened stops feeding a base its readers could not see it from.
  if (!mayProposeTo(base, cx.repo)) return;
  const baseReader = base === cx.repo ? cx.reader : cx.readers(cx.env, locatorOf(base));
  const fork = pull.headRepositoryId !== pull.repositoryId;
  let baseOid = pull.baseOid;

  // Only the first delivery finds the head elsewhere. What follows this block
  // is deduplicated by its own keys, so a redelivery finishes what a failed
  // one started without writing the timeline twice.
  if (pull.headOid !== update.newOid || !pull.headRefExists) {
    // What the pull request now is, when the storage can say; the head alone when it cannot.
    const comparison = await tryRead(() =>
      baseReader.compare({
        base: pull.baseRef,
        head: update.newOid,
        headRepositoryId: fork ? cx.repo.repository.id : undefined,
      }),
    );
    baseOid = comparison?.base.commitOid ?? pull.baseOid;
    await syncPullRequest(pull.issueId, {
      headOid: update.newOid,
      headRefExists: true,
      ...(comparison
        ? {
            baseOid,
            mergeBaseOid: comparison.mergeBaseOid,
            commitsCount: comparison.ahead,
            additions: comparison.stats.additions,
            deletions: comparison.stats.deletions,
            changedFiles: comparison.stats.filesChanged,
          }
        : {}),
    });
    const event = {
      issueId: thread.id,
      repositoryId: thread.repositoryId,
      actorUserId: cx.userId,
      at: new Date(cx.event.at),
    };
    if (update.forced) {
      await addTimelineEvent(db, {
        ...event,
        type: "head_force_pushed",
        payload: { beforeOid: pull.headOid, afterOid: update.newOid },
      });
    } else {
      await addTimelineEvent(db, {
        ...event,
        type: "committed",
        payload: { commitOids: commits?.map((commit) => commit.oid) ?? [update.newOid] },
      });
    }
    const protection = protectionFor(await listProtectedBranches(base.repository.id), pull.baseRef);
    if (protection?.dismissStaleApprovals) await dismissStaleApprovals(pull.issueId, update.newOid);
  }

  // Review threads follow their lines to the new version, or are answered by it.
  await carryThreads(cx, found, update.newOid);

  // CI fetches the head through `refs/pull/<n>/head` of the base repository.
  await tryRead(() =>
    baseReader.setPullRef({
      number: thread.number,
      headRepositoryId: cx.repo.repository.id,
      oid: update.newOid,
    }),
  );
  const synced: PullRequestWithThread = {
    thread,
    pull: { ...pull, headOid: update.newOid, baseOid },
  };
  await announcePullRequest(base, synced, "synchronize", cx.repo, cx.username);
  // The page's cost change from configuration, priced before anyone opens it.
  await scanAhead(baseReader, base.repository.id, [update.newOid, pull.mergeBaseOid]);
  // A fork's head never queues a plan in its base (`plansPullRequest`).
  if (!plansPullRequest(base.repository.id, pull.headRepositoryId)) return;
  await queuePullRequestPlans({
    repositoryId: base.repository.id,
    organizationId: base.owner.organizationId,
    defaultBranch: base.repository.defaultBranch,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    headOid: update.newOid,
    pullNumber: thread.number,
    userId: cx.userId,
    // By id, as CI tells: a head anywhere but in the base repository is a fork's.
    fromFork: fork,
    reader: baseReader,
    headRepositoryId: fork ? cx.repo.repository.id : undefined,
  });
};

/** Whether a `referenced` entry for this commit is already on the thread. */
const alreadyReferenced = async (issueId: string, commitOid: string): Promise<boolean> => {
  const [seen] = await db
    .select({ id: gitTimelineEvents.id })
    .from(gitTimelineEvents)
    .where(
      and(
        eq(gitTimelineEvents.issueId, issueId),
        eq(gitTimelineEvents.type, "referenced"),
        sql`${gitTimelineEvents.payload}->>'commitOid' = ${commitOid}`,
      ),
    )
    .limit(1);
  return seen !== undefined;
};

/** Commits that landed on the default branch: note each thread they name, and close the issues they fix. */
const applyCommitMessages = async (cx: PushContext, commits: readonly Commit[]): Promise<void> => {
  const repositoryId = cx.repo.repository.id;
  for (const [index, commit] of commits.entries()) {
    const closing = new Set(closingNumbers(commit.message));
    for (const number of new Set([...mentionedNumbers(commit.message), ...closing])) {
      const thread = await getThread(repositoryId, number);
      if (!thread) continue;
      if (!(await alreadyReferenced(thread.id, commit.oid))) {
        await addTimelineEvent(db, {
          issueId: thread.id,
          repositoryId,
          actorUserId: cx.userId,
          type: "referenced",
          payload: { commitOid: commit.oid },
          // A millisecond apart, so a timeline lists one push's commits in their order.
          at: new Date(cx.event.at + index),
        });
      }
      // A pull request is closed by merging it, never by a commit's say-so.
      if (closing.has(number) && !thread.isPullRequest && thread.state === "open") {
        await applyState(thread, "closed", {
          userId: cx.userId,
          reason: "completed",
          commitOid: commit.oid,
        });
      }
    }
  }
};

const handleBranch = async (cx: PushContext, update: Update, branch: string): Promise<void> => {
  const { repository } = cx.repo;
  const deleted = ZERO.test(update.newOid);
  const pulls = await openPullRequestsForBranch(repository.id, branch);
  const heads = pulls.filter(
    ({ pull }) => pull.headRepositoryId === repository.id && pull.headRef === branch,
  );

  if (deleted) {
    for (const found of heads) {
      const { thread, pull } = found;
      // A page never stays open without its branch: merged if the base has it, else closed.
      await settleDeletedHead(cx, found, async (at) => {
        if (!pull.headRefExists) return;
        await syncPullRequest(pull.issueId, { headRefExists: false });
        await addTimelineEvent(db, {
          issueId: thread.id,
          repositoryId: thread.repositoryId,
          actorUserId: cx.userId,
          type: "head_branch_deleted",
          payload: { ref: branch },
          at,
        });
      });
    }
    await branchDeleted(cx, branch);
    return;
  }

  // Every push is a version, the ones a later push has already overtaken included.
  const copied = await recordVersions(cx, update, branch, heads);

  // A delivery that arrives after the branch has moved on describes the past:
  // the event for where it is now does the work.
  const current = await tryRead(() => cx.reader.getBranch(branch));
  if (current && current.commit.oid !== update.newOid) return;

  const commits = await tryRead(() =>
    cx.reader.commitRange({
      base: ZERO.test(update.oldOid) || update.forced ? null : update.oldOid,
      head: update.newOid,
      limit: MAX_COMMITS,
    }),
  );

  // A branch with no page gets one: a draft pull request, opened at its head.
  const opened =
    heads.length === 0 ? await openBranchPage(cx, update, branch, copied, commits) : null;
  for (const found of heads) await syncHead(cx, found, update, commits);
  // The review agents read the new version, where the repository has them on.
  for (const found of opened ? [opened] : heads) {
    await queueReviewForVersion(cx, found, update.newOid);
  }
  for (const { pull } of pulls) {
    if (pull.repositoryId !== repository.id || pull.baseRef !== branch) continue;
    if (pull.baseOid !== update.newOid) {
      await syncPullRequest(pull.issueId, { baseOid: update.newOid });
    }
  }
  // The pages based on this branch whose changes it now has, however they got there, are merged.
  await settleBasePush(cx, branch, update.oldOid, pulls);

  if (branch === repository.defaultBranch && commits) await applyCommitMessages(cx, commits);

  await queueMergeApplies({
    repositoryId: repository.id,
    organizationId: cx.repo.owner.organizationId,
    defaultBranch: repository.defaultBranch,
    branch,
    oid: update.newOid,
    userId: cx.userId,
  });
};

/** One push. Throws only when the database is away, so the message is retried. */
export const handlePush = async (
  event: GitPushEvent,
  env: Env,
  readers: RepoReaderFactory = repoReaderFor,
): Promise<void> => {
  const repo = await getRepositoryById(event.repoId);
  // Deleted since the push: nothing is left to update.
  if (!repo) return;
  const reader = readers(env, locatorOf(repo));
  const userId = event.actor?.userId ?? null;
  const cx: PushContext = {
    env,
    repo,
    reader,
    readers,
    event,
    userId,
    username: userId ? ((await getNamespaceForUser(userId))?.slug ?? null) : null,
  };

  const stats = await tryRead(() => reader.stats());
  // The language bar is the default branch's: measured when a push moved it
  // to a commit not measured yet. Sizes come from the object's cache, so a
  // push that changed a few files reads a few.
  const defaultBranch = event.updates.find(
    (update) =>
      update.name === `${BRANCH}${repo.repository.defaultBranch}` && !ZERO.test(update.newOid),
  );
  const measured =
    defaultBranch && defaultBranch.newOid !== repo.repository.languagesCommit
      ? await tryRead(() => reader.languages({ ref: defaultBranch.newOid }))
      : null;
  await recordPush(repo.repository.id, {
    at: new Date(event.at),
    ...(stats
      ? {
          sizeBytes: stats.sizeBytes,
          branchesCount: stats.branchCount,
          tagsCount: stats.tagCount,
          isEmpty: stats.isEmpty,
        }
      : {}),
    ...(measured
      ? {
          languages: measured.languages,
          languagesCommit: measured.commitOid,
          primaryLanguage: measured.languages[0]?.name ?? null,
        }
      : {}),
  });

  // The Infrastructure tab's roots and estimates, read ahead of the first visit.
  if (defaultBranch) await scanAhead(reader, repo.repository.id, [defaultBranch.newOid]);

  for (const update of event.updates) {
    if (update.name.startsWith(BRANCH)) {
      await handleBranch(cx, update, update.name.slice(BRANCH.length));
    }
    // Every ref, tags and deletions included: CI decides what starts a run.
    await announcePush(repo, update, cx.username);
  }
};

/** Measures the default branch's languages when they were not measured at its tip. */
const measureLanguages = async (
  repoId: string,
  env: Env,
  readers: RepoReaderFactory = repoReaderFor,
): Promise<void> => {
  const repo = await getRepositoryById(repoId);
  if (!repo || repo.repository.isEmpty) return;
  const reader = readers(env, locatorOf(repo));
  const measured = await tryRead(() =>
    reader.languages({ ref: `${BRANCH}${repo.repository.defaultBranch}` }),
  );
  if (!measured || measured.commitOid === repo.repository.languagesCommit) return;
  await recordPush(repoId, {
    at: repo.repository.pushedAt ?? new Date(),
    languages: measured.languages,
    languagesCommit: measured.commitOid,
    primaryLanguage: measured.languages[0]?.name ?? null,
  });
};

/**
 * A push moved refs: the repository's push mirrors are owed a run
 * (`mirror/store.ts`), and each is sent to the jobs queue. First, and apart
 * from everything else a push sets off, so a mirror does not wait on CI or
 * a review. Raising the number twice for a message delivered twice costs a
 * run that finds nothing to do.
 */
const mirrorPush = async (repositoryId: string, env: Env): Promise<void> => {
  const ids = await markMirrorsPending(repositoryId);
  for (const mirrorId of ids) {
    try {
      await enqueueJob(env, { type: "mirror", mirrorId });
    } catch (error) {
      // The sweep sends it within two minutes.
      console.error(`[git] mirror ${mirrorId} could not be queued: ${describeError(error)}`);
    }
  }
};

export const handleGitEvent = (
  event: GitEvent,
  env: Env,
  readers?: RepoReaderFactory,
): Promise<void> => {
  switch (event.type) {
    case "push":
      return mirrorPush(event.repoId, env).then(() => handlePush(event, env, readers));
    case "languages":
      return measureLanguages(event.repoId, env, readers);
  }
};

/** The Worker's `queue` handler: one database client for the batch, each message settled on its own. */
export const consumeGitEvents = async (
  batch: MessageBatch<GitEvent>,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> => {
  await withDb(env, ctx, async () => {
    for (const message of batch.messages) {
      try {
        await handleGitEvent(message.body, env);
        message.ack();
      } catch (error) {
        console.error(
          `[git] event ${message.id} failed and will be retried: ${describeError(error)}`,
        );
        message.retry();
      }
    }
  });
};
