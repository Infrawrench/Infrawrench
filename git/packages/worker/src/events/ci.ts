/**
 * Telling Infrawrench CI what happened to a repository (NOTES-ci.md section
 * 1). CI decides everything itself (tags, deleted branches, a person's own
 * namespace that is connected to no organisation, an organisation without a
 * paid plan, redeliveries all start nothing), so every event is passed on
 * unfiltered. That includes which organisation a person's own repository
 * runs in: the event says only who owns the namespace, and CI reads the
 * connection itself (`acceptGitEvent`).
 *
 * `ci/git-events` reaches most of server-core, so it is imported when the
 * first event arrives, never at the Worker's start.
 */
import type { PullRequestWithThread } from "../db/pulls";
import type { RepositoryWithOwner } from "../db/repositories";

const ciEvents = () => import("@infrawrench/server-core/ci/git-events");

/** A repository as CI names it. `organizationId` is the owner's: null for a person's namespace. */
export const ciRepository = ({ repository, owner }: RepositoryWithOwner) => ({
  id: repository.id,
  namespace: owner.slug,
  name: repository.name,
  defaultBranch: repository.defaultBranch,
  organizationId: owner.organizationId,
});

const ZERO = /^0+$/;

/** One branch or tag a push moved. Throws when the database is away, so the message retries. */
export const announcePush = async (
  repo: RepositoryWithOwner,
  update: {
    readonly name: string;
    readonly oldOid: string;
    readonly newOid: string;
    readonly forced: boolean;
  },
  pusher: string | null,
): Promise<void> => {
  const { handleGitEvent } = await ciEvents();
  await handleGitEvent({
    kind: "push",
    repository: ciRepository(repo),
    ref: update.name,
    before: ZERO.test(update.oldOid) ? null : update.oldOid,
    after: ZERO.test(update.newOid) ? null : update.newOid,
    forced: update.forced,
    pusher,
  });
};

/**
 * A pull request that was opened, reopened, or whose head moved. `head` is
 * the repository the head commit is in, or null for a fork that is gone.
 * Never pass the base repository as a fork's head: a fork's run must wait for
 * approval and get no secrets, and CI tells by this id.
 */
export const announcePullRequest = async (
  base: RepositoryWithOwner,
  { thread, pull }: PullRequestWithThread,
  action: "opened" | "synchronize" | "reopened",
  head: RepositoryWithOwner | null,
  actor: string | null,
): Promise<void> => {
  const { handleGitEvent } = await ciEvents();
  await handleGitEvent({
    kind: "pull_request",
    repository: ciRepository(base),
    action,
    number: thread.number,
    head: {
      sha: pull.headOid,
      ref: pull.headRef,
      repository: head
        ? { id: head.repository.id, fullName: `${head.owner.slug}/${head.repository.name}` }
        : null,
    },
    base: { sha: pull.baseOid, ref: pull.baseRef },
    actor,
  });
};
