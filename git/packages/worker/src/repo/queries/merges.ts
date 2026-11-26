/**
 * Merging: the trial that says whether a pull request merges, the merge
 * itself in its three ways, and bringing a head branch up to date.
 *
 * A merge is computed against the base as it was read, its objects are
 * written, and the base branch is moved only if it is still there
 * (`applyUpdates` compares). Losing that race costs nothing but the work:
 * the objects written are unreachable, and the merge is computed once more
 * against the new base before the caller is told the base moved.
 */
import { GitError, type ObjectId, type Signature } from "@infrawrench/git-core";
import {
  type MergeOutcome as OpsOutcome,
  aheadBehind,
  mergeWithCommit,
  normalizeMessage,
  rebaseMerge,
  signature,
  squashMerge,
} from "@infrawrench/git-ops";
import type { GitEventActor } from "../../env";
import {
  type CommitIdentity,
  type MergeInput,
  type MergeOutcome,
  type ReaderMergeability,
  RepoReaderError,
  type UpdateBranchInput,
  type UpdateBranchOutcome,
} from "../reader";
import { trialMerge } from "./diffs";
import { moveRef } from "./refs";
import { BRANCH, type ReaderContext, type Session, branchTip, openSession } from "./session";

/** The base moved under a merge this many times before the caller hears of it. */
const MERGE_ATTEMPTS = 2;

const who = (cx: ReaderContext, identity: CommitIdentity): Signature => {
  const name = identity.name.trim() !== "" ? identity.name : identity.email.split("@")[0] || "user";
  try {
    return signature({ name, email: identity.email }, cx.now);
  } catch (error) {
    // A name made only of characters git strips.
    if (error instanceof GitError)
      return signature({ name: "user", email: identity.email }, cx.now);
    throw error;
  }
};

const limited = (error: unknown): never => {
  if (error instanceof GitError && error.code === "limit") {
    throw new RepoReaderError("too_large", error.message);
  }
  throw error;
};

const pathsOf = (outcome: Extract<OpsOutcome, { status: "conflicts" }>): string[] => [
  ...new Set(outcome.conflicts.map((conflict) => conflict.path)),
];

/** A session that has `headOid`, copied in from its repository when that is another one. */
async function withHead(
  cx: ReaderContext,
  headRepositoryId: string,
  headOid: ObjectId,
): Promise<Session> {
  if (!(await cx.repo.importFrom(headRepositoryId, [headOid]))) {
    throw new RepoReaderError("ref_not_found", "The head commit is not there");
  }
  const session = await openSession(cx);
  if (!(await session.objects.has(headOid))) {
    throw new RepoReaderError("ref_not_found", "The head commit is not there");
  }
  return session;
}

const baseTip = (session: Session, name: string): ObjectId => {
  const oid = branchTip(session, name);
  if (oid === null) {
    throw new RepoReaderError("ref_not_found", `There is no branch ${JSON.stringify(name)}`);
  }
  return oid;
};

export async function mergeability(
  cx: ReaderContext,
  input: { readonly baseRef: string; readonly headRepositoryId: string; readonly headOid: string },
): Promise<ReaderMergeability> {
  const session = await withHead(cx, input.headRepositoryId, input.headOid);
  const baseOid = baseTip(session, input.baseRef);
  const trial = await trialMerge(session, baseOid, input.headOid);
  let counts = { ahead: 0, behind: 0 };
  try {
    counts = await aheadBehind(session.cache, input.headOid, baseOid);
  } catch (error) {
    limited(error);
  }
  return {
    state: trial.conflictFiles.length > 0 ? "conflicting" : "clean",
    conflictFiles: trial.conflictFiles,
    baseOid,
    headOid: input.headOid,
    mergeBaseOid: trial.mergeBaseOid,
    aheadBy: counts.ahead,
    behindBy: counts.behind,
  };
}

/** Writes what a merge made and moves the branch, if it is still where the merge read it. */
async function land(
  cx: ReaderContext,
  outcome: Extract<OpsOutcome, { status: "merged" | "fast-forward" }>,
  ref: string,
  from: ObjectId,
  actor: GitEventActor | null,
): Promise<"moved" | "stale" | "missing"> {
  if (outcome.status === "merged") {
    await cx.repo.writeObjects(outcome.objects.map(({ type, data }) => ({ type, data })));
  }
  const moved = await moveRef(
    cx,
    { name: ref, oldOid: from, newOid: outcome.commit },
    { actor, notify: true },
  );
  return moved === "exists" ? "stale" : moved;
}

export async function merge(cx: ReaderContext, input: MergeInput): Promise<MergeOutcome> {
  const committer = who(cx, input.committer);
  const title = input.title.trim() !== "" ? input.title : `Merge ${input.headOid.slice(0, 7)}`;
  const message = normalizeMessage(`${title}\n\n${input.message}`);

  for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
    const session = await withHead(cx, input.headRepositoryId, input.headOid);
    const baseOid = baseTip(session, input.baseRef);
    let outcome: OpsOutcome;
    try {
      if (input.method === "merge") {
        outcome = await mergeWithCommit(
          session.cache,
          baseOid,
          input.headOid,
          { author: committer, committer, message },
          { fastForward: "never", theirs: input.headOid.slice(0, 7), ours: input.baseRef },
        );
      } else if (input.method === "squash") {
        const head = await session.cache.commit(input.headOid);
        const author: Signature = {
          name: head.author.name,
          email: head.author.email,
          timestamp: committer.timestamp,
          timezoneOffset: 0,
        };
        outcome = await squashMerge(
          session.cache,
          baseOid,
          input.headOid,
          { author, committer, message },
          { theirs: input.headOid.slice(0, 7), ours: input.baseRef },
        );
      } else {
        outcome = await rebaseMerge(session.cache, baseOid, input.headOid, committer, {
          maxCommits: cx.limits.rebaseCommits,
        });
      }
    } catch (error) {
      return limited(error);
    }
    if (outcome.status === "conflicts") {
      return { merged: false, reason: "conflicts", conflictFiles: pathsOf(outcome) };
    }
    // The base already has everything the head has: nothing to write, nothing to move.
    if (outcome.status === "up-to-date") return { merged: true, commitOid: baseOid };
    const landed = await land(cx, outcome, BRANCH + input.baseRef, baseOid, input.actor);
    if (landed === "moved") return { merged: true, commitOid: outcome.commit };
    if (landed === "missing") {
      throw new RepoReaderError("ref_not_found", `There is no branch ${input.baseRef}`);
    }
  }
  return { merged: false, reason: "base_moved" };
}

export async function updateBranch(
  cx: ReaderContext,
  input: UpdateBranchInput,
): Promise<UpdateBranchOutcome> {
  const committer = who(cx, input.committer);
  let session = await openSession(cx);
  const headOid = baseTip(session, input.headRef);
  if (input.expectedHeadOid !== undefined && input.expectedHeadOid !== headOid) {
    throw new RepoReaderError("head_moved", "The branch has moved since it was looked at");
  }
  let baseOid: ObjectId;
  if (input.baseRepositoryId === cx.locator.id) {
    baseOid = baseTip(session, input.baseRef);
  } else {
    const { refs } = await cx.repo.peer(input.baseRepositoryId).listRefs();
    const found = refs.find((ref) => ref.name === BRANCH + input.baseRef);
    if (!found || !(await cx.repo.importFrom(input.baseRepositoryId, [found.oid]))) {
      throw new RepoReaderError("ref_not_found", `There is no branch ${input.baseRef} there`);
    }
    baseOid = found.oid;
    session = await openSession(cx);
  }

  let outcome: OpsOutcome;
  try {
    outcome =
      input.method === "merge"
        ? await mergeWithCommit(
            session.cache,
            headOid,
            baseOid,
            {
              author: committer,
              committer,
              message: `Merge branch '${input.baseRef}' into ${input.headRef}\n`,
            },
            { fastForward: "never", ours: input.headRef, theirs: input.baseRef },
          )
        : await rebaseMerge(session.cache, baseOid, headOid, committer, {
            maxCommits: cx.limits.rebaseCommits,
          });
  } catch (error) {
    return limited(error);
  }
  if (outcome.status === "conflicts") {
    return { updated: false, reason: "conflicts", conflictFiles: pathsOf(outcome) };
  }
  // Merge: the head has the base already. Rebase: the head has nothing of its own, so it becomes the base.
  const target = outcome.commit;
  if (outcome.status === "up-to-date" && (input.method === "merge" || target === headOid)) {
    return { updated: false, reason: "up_to_date", headOid };
  }
  // Rebase: every commit already sits on the base.
  if (target === headOid) return { updated: false, reason: "up_to_date", headOid };
  const landed = await land(
    cx,
    outcome.status === "up-to-date" ? { status: "fast-forward", commit: target } : outcome,
    BRANCH + input.headRef,
    headOid,
    input.actor,
  );
  if (landed !== "moved") {
    throw new RepoReaderError("head_moved", "The branch moved while it was being updated");
  }
  return { updated: true, headOid: target };
}
