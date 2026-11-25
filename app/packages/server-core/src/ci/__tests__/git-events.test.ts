import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitPullRequestInput, GitPushInput } from "../git-events";
import type { EventRun } from "../runs";

const state = {
  paid: true,
  ciEnabled: true,
  recorded: [] as EventRun[],
  noted: [] as Array<Record<string, unknown>>,
  dispatched: [] as string[],
  announced: [] as string[],
  seen: new Set<string>(),
};

vi.mock("../../db/client.js", () => ({ db: {} }));
vi.mock("../../entitlements.js", () => ({
  planAccess: async () => ({ paid: state.paid }),
}));
vi.mock("../git-repositories.js", async (orig) => ({
  ...(await orig<typeof import("../git-repositories")>()),
  noteGitRepository: async (ref: { id: string; namespace: string; name: string }) => ({
    gitRepositoryId: ref.id,
    repoFullName: `${ref.namespace}/${ref.name}`,
    defaultBranch: "main",
    ciEnabled: state.ciEnabled,
  }),
}));
vi.mock("../schedules.js", () => ({
  noteRepository: async (input: Record<string, unknown>) => {
    state.noted.push(input);
  },
}));
vi.mock("../runs.js", () => ({
  // As the table's unique index on the dedupe key does it.
  recordEventRun: async (run: EventRun) => {
    if (state.seen.has(run.dedupeKey)) return null;
    state.seen.add(run.dedupeKey);
    state.recorded.push(run);
    return {
      id: `run-${state.recorded.length}`,
      status: run.pull?.fromFork ? "awaiting_approval" : "queued",
    };
  },
  dispatchRun: async (id: string) => {
    state.dispatched.push(id);
  },
  announceAwaitingApproval: async (id: string) => {
    state.announced.push(id);
  },
}));

const { acceptGitEvent, gitDedupeKey, handleGitEvent, parseGitEvent } =
  await import("../git-events");

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

const repository = {
  id: "repo-1",
  namespace: "Acme",
  name: "web",
  defaultBranch: "main",
  organizationId: "org-1",
};

const push = (over: Partial<GitPushInput> = {}): GitPushInput => ({
  kind: "push",
  repository,
  ref: "refs/heads/main",
  before: B,
  after: A,
  forced: false,
  pusher: "octo",
  ...over,
});

const pull = (over: Partial<GitPullRequestInput> = {}): GitPullRequestInput => ({
  kind: "pull_request",
  repository,
  action: "opened",
  number: 7,
  head: { sha: A, ref: "feature/x", repository: { id: "repo-1", fullName: "Acme/web" } },
  base: { sha: B, ref: "main" },
  actor: "octo",
  ...over,
});

beforeEach(() => {
  state.paid = true;
  state.ciEnabled = true;
  state.recorded = [];
  state.noted = [];
  state.dispatched = [];
  state.announced = [];
  state.seen = new Set();
  delete process.env["GIT_BASE_URL"];
});

describe("parseGitEvent", () => {
  it("reads a push to a branch, with the commit it moved from as its base", () => {
    expect(parseGitEvent(push())).toEqual({
      kind: "push",
      repository,
      branch: "main",
      sha: A,
      baseSha: B,
      actorLogin: "octo",
    });
  });

  it("keeps a branch name with slashes whole", () => {
    expect(parseGitEvent(push({ ref: "refs/heads/release/1.2" }))).toMatchObject({
      branch: "release/1.2",
    });
  });

  it("has no base for a new branch, by flag or by a zero commit", () => {
    expect(parseGitEvent(push({ created: true }))).toMatchObject({ baseSha: null });
    expect(parseGitEvent(push({ before: ZERO }))).toMatchObject({ baseSha: null });
    expect(parseGitEvent(push({ before: null }))).toMatchObject({ baseSha: null });
  });

  it("has no base for a forced push, whose old head the new one need not descend from", () => {
    expect(parseGitEvent(push({ forced: true }))).toMatchObject({ sha: A, baseSha: null });
  });

  it("starts nothing for a deleted branch, a tag or any other ref", () => {
    expect(parseGitEvent(push({ deleted: true }))).toBeNull();
    expect(parseGitEvent(push({ after: ZERO }))).toBeNull();
    expect(parseGitEvent(push({ after: null }))).toBeNull();
    expect(parseGitEvent(push({ ref: "refs/tags/v1" }))).toBeNull();
    expect(parseGitEvent(push({ ref: "refs/pull/7/head" }))).toBeNull();
    expect(parseGitEvent(push({ ref: "refs/heads/" }))).toBeNull();
  });

  it("refuses a commit that is not one, and a repository it could not clone", () => {
    expect(parseGitEvent(push({ after: "not-a-sha" }))).toBeNull();
    expect(parseGitEvent(push({ repository: { ...repository, name: "../etc" } }))).toBeNull();
    expect(parseGitEvent(push({ repository: { ...repository, namespace: "a/b" } }))).toBeNull();
    expect(parseGitEvent(push({ repository: { ...repository, id: "" } }))).toBeNull();
  });

  it("reads a pull request from the repository itself", () => {
    expect(parseGitEvent(pull())).toEqual({
      kind: "pull_request",
      repository,
      number: 7,
      headSha: A,
      headRef: "feature/x",
      headRepoFullName: "Acme/web",
      baseSha: B,
      actorLogin: "octo",
      fromFork: false,
    });
  });

  it("runs for opened, synchronize and reopened, and nothing else", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      expect(parseGitEvent(pull({ action }))).not.toBeNull();
    }
    for (const action of ["closed", "edited", "labeled", "merged", ""]) {
      expect(parseGitEvent(pull({ action }))).toBeNull();
    }
  });

  it("calls a head in another repository a fork, by id and never by name", () => {
    const fork = pull({
      // The same name as the base repository: only the id tells them apart.
      head: { sha: A, ref: "main", repository: { id: "repo-2", fullName: "Acme/web" } },
    });
    expect(parseGitEvent(fork)).toMatchObject({ fromFork: true });
  });

  it("calls a head whose repository is gone a fork", () => {
    const gone = pull({ head: { sha: A, ref: "main", repository: null } });
    expect(parseGitEvent(gone)).toMatchObject({ fromFork: true, headRepoFullName: null });
  });
});

describe("gitDedupeKey", () => {
  it("is one per repository id, target and commit, whatever the repository is called", () => {
    const first = parseGitEvent(push())!;
    const renamed = parseGitEvent(push({ repository: { ...repository, name: "site" } }))!;
    expect(gitDedupeKey(first)).toBe(`git-push:repo-1:main:${A}`);
    expect(gitDedupeKey(renamed)).toBe(gitDedupeKey(first));
    expect(gitDedupeKey(parseGitEvent(pull())!)).toBe(`git-pr:repo-1:7:${A}`);
    // A push and a pull request of one commit are two runs.
    expect(gitDedupeKey(parseGitEvent(pull())!)).not.toBe(gitDedupeKey(first));
  });
});

describe("acceptGitEvent", () => {
  it("records a push as a queued run of the forge's owner", async () => {
    expect(await acceptGitEvent(push())).toEqual({ id: "run-1", status: "queued" });
    expect(state.recorded[0]).toEqual({
      organizationId: "org-1",
      installationId: 0,
      gitRepositoryId: "repo-1",
      repoFullName: "Acme/web",
      ownerKey: "git.infrawrench.com-acme",
      repoKey: "web",
      defaultBranch: "main",
      actorLogin: "octo",
      dedupeKey: `git-push:repo-1:main:${A}`,
      sha: A,
      baseSha: B,
      branch: "main",
    });
  });

  it("makes no second run for a redelivered event", async () => {
    expect(await acceptGitEvent(push())).not.toBeNull();
    expect(await acceptGitEvent(push())).toBeNull();
    expect(state.recorded).toHaveLength(1);
  });

  it("re-reads the schedules on a push to the default branch only", async () => {
    await acceptGitEvent(push());
    await acceptGitEvent(push({ ref: "refs/heads/feature/x", after: B, before: A }));
    await acceptGitEvent(pull());
    expect(state.noted.map((n) => n["refreshNow"])).toEqual([true, false, false]);
    expect(state.noted[0]).toMatchObject({
      installationId: 0,
      gitRepositoryId: "repo-1",
      repoFullName: "Acme/web",
    });
  });

  it("queues a pull request from the repository itself", async () => {
    expect(await acceptGitEvent(pull())).toEqual({ id: "run-1", status: "queued" });
    expect(state.recorded[0]?.pull).toEqual({
      number: 7,
      headRef: "feature/x",
      headRepoFullName: "Acme/web",
      fromFork: false,
    });
    expect(state.recorded[0]).toMatchObject({ sha: A, baseSha: B });
  });

  it("makes a fork's pull request wait for approval", async () => {
    const fork = pull({
      head: { sha: A, ref: "main", repository: { id: "repo-9", fullName: "mallory/web" } },
    });
    expect(await acceptGitEvent(fork)).toEqual({ id: "run-1", status: "awaiting_approval" });
    expect(state.recorded[0]?.pull).toMatchObject({
      fromFork: true,
      headRepoFullName: "mallory/web",
    });
  });

  it("runs nothing for a person's own namespace", async () => {
    const own = push({ repository: { ...repository, organizationId: null } });
    expect(await acceptGitEvent(own)).toBeNull();
    expect(state.recorded).toHaveLength(0);
  });

  it("runs nothing, quietly, for an organization without a paid plan", async () => {
    state.paid = false;
    expect(await acceptGitEvent(push())).toBeNull();
    expect(state.recorded).toHaveLength(0);
    expect(state.noted).toHaveLength(0);
  });

  it("runs nothing for a repository with CI switched off", async () => {
    state.ciEnabled = false;
    expect(await acceptGitEvent(push())).toBeNull();
    expect(await acceptGitEvent(pull())).toBeNull();
    expect(state.recorded).toHaveLength(0);
  });

  it("names the owner after the configured forge's host", async () => {
    process.env["GIT_BASE_URL"] = "https://git.example.test:8443/";
    await acceptGitEvent(push());
    expect(state.recorded[0]?.ownerKey).toBe("git.example.test-acme");
  });
});

describe("handleGitEvent", () => {
  it("dispatches a queued run", async () => {
    await handleGitEvent(push());
    expect(state.dispatched).toEqual(["run-1"]);
    expect(state.announced).toEqual([]);
  });

  it("announces a fork's run as waiting, and dispatches nothing", async () => {
    await handleGitEvent(
      pull({ head: { sha: A, ref: "main", repository: { id: "repo-9", fullName: "m/web" } } }),
    );
    expect(state.dispatched).toEqual([]);
    expect(state.announced).toEqual(["run-1"]);
  });

  it("does nothing for an event that starts no run", async () => {
    expect(await handleGitEvent(push({ ref: "refs/tags/v1" }))).toBeNull();
    expect(state.dispatched).toEqual([]);
  });
});
