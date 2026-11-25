/**
 * Pushes and pull requests on git.infrawrench.com that start CI runs.
 *
 * The forge's event queue consumer calls {@link handleGitEvent} for each ref
 * a push moved and each pull request that got new code
 * (`git/packages/worker/NOTES-ci.md`). The rules are GitHub's, from
 * `events.ts` and `runs.ts`, so a repository behaves the same on either
 * forge:
 *
 * - Only branches run: a tag, a deleted branch and any other ref start
 *   nothing.
 * - A push's `base` (what `paths:` and `changed()` diff against) is the
 *   commit the branch was at before, unless the branch is new or the push
 *   was forced, whose old head the new one need not descend from.
 * - A pull request runs when it is opened, reopened or gets new commits. One
 *   whose head is in another repository (or in none: a deleted fork) is a
 *   fork's: it waits for a maintainer and is **never** sent `trusted`, so it
 *   gets no secrets and nothing lent (`dispatchBody`).
 * - A redelivered event makes no second run: the dedupe key is the
 *   repository's id, the branch or pull request, and the commit.
 *
 * `parseGitEvent` is pure, so the rules are tested without a database.
 */
import type { CiRunStatus } from "@infrawrench/client-core";

import { planAccess } from "../entitlements.js";
import { repoKey } from "./events.js";
import {
  gitRepoFullName,
  noteGitRepository,
  validGitRepositoryRef,
  type GitRepositoryRef,
} from "./git-repositories.js";
import { announceAwaitingApproval, dispatchRun, recordEventRun } from "./runs.js";
import { noteRepository } from "./schedules.js";
import { GIT_SOURCE_INSTALLATION_ID, gitOwnerKey } from "./source.js";

/** One ref a push moved, as the repository's Durable Object reports it. */
export interface GitPushInput {
  kind: "push";
  repository: GitRepositoryRef;
  /** The full ref: `refs/heads/main`. */
  ref: string;
  /** The ref's old commit; null or all zeros when it did not exist. */
  before: string | null;
  /** Its new commit; null or all zeros when the ref was deleted. */
  after: string | null;
  /** The new commit does not descend from the old one. */
  forced: boolean;
  /** The ref did not exist; taken from `before` when left out. */
  created?: boolean;
  /** The ref is gone; taken from `after` when left out. */
  deleted?: boolean;
  /** The forge username of whoever pushed, when there is one (not a deploy key). */
  pusher: string | null;
}

/** A pull request that may have new code to test. */
export interface GitPullRequestInput {
  kind: "pull_request";
  repository: GitRepositoryRef;
  /** `opened`, `synchronize` (new commits) or `reopened`; any other action starts nothing. */
  action: string;
  number: number;
  head: {
    sha: string;
    /** The head branch's name, for display. */
    ref: string;
    /** The repository the head branch is in; null when it has been deleted. */
    repository: { id: string; fullName: string } | null;
  };
  base: {
    /** The base branch's head, which `paths:` and `changed()` diff against. */
    sha: string;
    ref: string;
  };
  /** The forge username of whoever opened it or pushed to it. */
  actor: string | null;
}

export type GitEventInput = GitPushInput | GitPullRequestInput;

/** A push that starts a run, read into what CI needs. */
export interface CiGitPushEvent {
  kind: "push";
  repository: GitRepositoryRef;
  branch: string;
  sha: string;
  baseSha: string | null;
  actorLogin: string | null;
}

export interface CiGitPullRequestEvent {
  kind: "pull_request";
  repository: GitRepositoryRef;
  number: number;
  headSha: string;
  headRef: string;
  headRepoFullName: string | null;
  baseSha: string;
  actorLogin: string | null;
  /** Opened from another repository: needs approval, never gets secrets. */
  fromFork: boolean;
}

export type CiGitEvent = CiGitPushEvent | CiGitPullRequestEvent;

const SHA = /^[0-9a-f]{40}$/;
const NO_COMMIT = /^0+$/;
/** The same actions as GitHub's: "there is new code to test". */
const PULL_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
const BRANCHES = "refs/heads/";

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const commit = (v: unknown): string | null => {
  const sha = text(v)?.toLowerCase() ?? null;
  return sha !== null && SHA.test(sha) && !NO_COMMIT.test(sha) ? sha : null;
};

/** The CI event in a forge event, or `null` when it starts nothing. */
export function parseGitEvent(input: GitEventInput): CiGitEvent | null {
  if (typeof input !== "object" || input === null) return null;
  const repository = input.repository;
  if (typeof repository !== "object" || repository === null || !validGitRepositoryRef(repository)) {
    return null;
  }

  if (input.kind === "push") {
    // Tags and every other ref start nothing; neither does a deleted branch.
    const ref = text(input.ref);
    if (!ref?.startsWith(BRANCHES) || ref.length === BRANCHES.length) return null;
    const sha = commit(input.after);
    if (input.deleted === true || sha === null) return null;
    const before = commit(input.before);
    const comparable = before !== null && input.created !== true && input.forced !== true;
    return {
      kind: "push",
      repository,
      branch: ref.slice(BRANCHES.length),
      sha,
      baseSha: comparable ? before : null,
      actorLogin: text(input.pusher),
    };
  }

  if (input.kind === "pull_request") {
    if (!PULL_ACTIONS.has(input.action)) return null;
    const number = input.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return null;
    const headSha = commit(input.head?.sha);
    const headRef = text(input.head?.ref);
    const baseSha = commit(input.base?.sha);
    if (headSha === null || headRef === null || baseSha === null) return null;
    const headRepository = input.head.repository;
    const headId = text(headRepository?.id);
    return {
      kind: "pull_request",
      repository,
      number,
      headSha,
      headRef,
      headRepoFullName: text(headRepository?.fullName),
      baseSha,
      actorLogin: text(input.actor),
      // By id, never by name: a head anywhere but in this repository, or in
      // one that is gone, is not this repository's code.
      fromFork: headId === null || headId !== repository.id,
    };
  }

  return null;
}

/** The dedupe key of an event's run: one run per repository, target and commit. */
export function gitDedupeKey(ev: CiGitEvent): string {
  return ev.kind === "pull_request"
    ? `git-pr:${ev.repository.id}:${ev.number}:${ev.headSha}`
    : `git-push:${ev.repository.id}:${ev.branch}:${ev.sha}`;
}

/**
 * Records the run a forge event asks for. Returns it, or `null` when the
 * event starts nothing: not a branch or a pull request with new code, a
 * person's own namespace, an organization without a paid plan, a repository
 * with CI switched off, or a redelivery.
 *
 * An organization that cannot run CI is skipped quietly. On GitHub someone
 * chose the account, so a run that cannot start says why on the commit;
 * here every repository is on by default, and a failed status on every
 * push of an organization that never asked for CI would only be noise.
 */
export async function acceptGitEvent(
  input: GitEventInput,
): Promise<{ id: string; status: CiRunStatus } | null> {
  const ev = parseGitEvent(input);
  if (!ev) return null;
  const { repository } = ev;
  const organizationId = repository.organizationId;
  if (!organizationId) return null;
  if (!(await planAccess(organizationId)).paid) return null;
  const noted = await noteGitRepository({ ...repository, organizationId });
  if (!noted.ciEnabled) return null;

  const repoFullName = gitRepoFullName(repository);
  const isPull = ev.kind === "pull_request";
  // Where its `on.schedule` and `on.manual` pipelines are read from: a push
  // to the default branch is the only way they change, so it re-reads them.
  await noteRepository({
    organizationId,
    installationId: GIT_SOURCE_INSTALLATION_ID,
    gitRepositoryId: repository.id,
    repoFullName,
    defaultBranch: repository.defaultBranch,
    refreshNow: !isPull && ev.branch === repository.defaultBranch,
  }).catch((err) => console.warn(`[ci] noting ${repoFullName} for schedules failed:`, err));

  const common = {
    organizationId,
    installationId: GIT_SOURCE_INSTALLATION_ID,
    gitRepositoryId: repository.id,
    repoFullName,
    ownerKey: gitOwnerKey(repository.namespace),
    repoKey: repoKey(repoFullName),
    defaultBranch: repository.defaultBranch,
    actorLogin: ev.actorLogin,
    dedupeKey: gitDedupeKey(ev),
  };
  return isPull
    ? recordEventRun({
        ...common,
        sha: ev.headSha,
        baseSha: ev.baseSha,
        pull: {
          number: ev.number,
          headRef: ev.headRef,
          headRepoFullName: ev.headRepoFullName,
          fromFork: ev.fromFork,
        },
      })
    : recordEventRun({ ...common, sha: ev.sha, baseSha: ev.baseSha, branch: ev.branch });
}

/**
 * Records an event's run and starts it: dispatched to the runners, or for a
 * fork's pull request shown on the commit as waiting for a maintainer. The
 * queue consumer's one call. The `ci` poller pass retries a dispatch that
 * does not go through, so a failure here after the run is recorded is
 * logged, not thrown: retrying the message would only find the run again.
 */
export async function handleGitEvent(
  input: GitEventInput,
): Promise<{ id: string; status: CiRunStatus } | null> {
  const accepted = await acceptGitEvent(input);
  if (!accepted) return null;
  try {
    if (accepted.status === "queued") await dispatchRun(accepted.id);
    else if (accepted.status === "awaiting_approval") await announceAwaitingApproval(accepted.id);
  } catch (err) {
    console.warn(`[ci] starting run ${accepted.id} failed; the poller will retry:`, err);
  }
  return accepted;
}
