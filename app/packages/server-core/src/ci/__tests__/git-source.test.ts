import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyGitJobToken } from "@infrawrench/client-core";

// `runs.ts` imports the database client and the GitHub App at load; nothing
// here touches the first, and the second only to prove a GitHub run still
// gets its installation's token.
vi.mock("../../db/client.js", () => ({ db: {} }));
vi.mock("../../github/app.js", () => ({
  getInstallationToken: async (id: number) => `installation-token-for-${id}`,
  getBranchHeadSha: async () => null,
}));

const { dispatchBody, toWire } = await import("../runs");
const source = await import("../source");
const { cleanRepos } = await import("../access");
const { scopeRefusal } = await import("../lend");

const KEY = "k".repeat(48);
const A = "a".repeat(40);
const B = "b".repeat(40);
// Obviously fake, and in no real token format.
const TOKEN = "clone-token-for-tests";

const gitRun = {
  repoFullName: "Acme/web",
  gitRepositoryId: "repo-1",
  sha: A,
  ownerKey: "git.infrawrench.com-acme",
  repoKey: "web",
  defaultBranch: "main",
  baseSha: B,
  noTaskCache: false,
  pipelineText: null,
  pipelineFile: null,
  inputs: null,
};

afterEach(() => {
  delete process.env["GIT_BASE_URL"];
  delete process.env["GIT_JOB_TOKEN_KEY"];
});

describe("a run's source", () => {
  it("is the forge's with a repository id, and GitHub's without one", () => {
    expect(source.sourceKind({ gitRepositoryId: "repo-1" })).toBe("git");
    expect(source.sourceKind({ gitRepositoryId: null })).toBe("github");
    expect(source.sourceKind({})).toBe("github");
    expect(source.sourceKind({ gitRepositoryId: "" })).toBe("github");
  });

  it("clones from the forge, at the configured base URL, without a credential", () => {
    expect(source.cloneUrl(gitRun)).toBe("https://git.infrawrench.com/Acme/web.git");
    process.env["GIT_BASE_URL"] = "https://git.example.test/";
    expect(source.cloneUrl(gitRun)).toBe("https://git.example.test/Acme/web.git");
    expect(source.cloneUrl({ repoFullName: "acme/web" })).toBe("https://github.com/acme/web.git");
  });

  it("links to the commit and the pull request on the right forge", () => {
    expect(source.commitUrl(gitRun, A)).toBe(`https://git.infrawrench.com/Acme/web/commit/${A}`);
    expect(source.pullUrl(gitRun, 7)).toBe("https://git.infrawrench.com/Acme/web/pull/7");
    expect(source.commitUrl({ repoFullName: "acme/web" }, A)).toBe(
      `https://github.com/acme/web/commit/${A}`,
    );
  });

  it("names the runner's owner the way the runner reads it from the clone URL", () => {
    expect(source.gitOwnerKey("Acme")).toBe("git.infrawrench.com-acme");
    expect(source.sourceOwnerKey(gitRun)).toBe("git.infrawrench.com-acme");
    expect(source.sourceOwnerKey({ repoFullName: "Acme/web" })).toBe("github.com-acme");
    process.env["GIT_BASE_URL"] = "https://Git.Example.test:8443";
    // Host only, lowercased: the runner drops the port too.
    expect(source.gitOwnerKey("Acme")).toBe("git.example.test-acme");
  });
});

describe("cloneToken", () => {
  it("is a read-only job token for that one repository, naming the run", async () => {
    process.env["GIT_JOB_TOKEN_KEY"] = KEY;
    const token = await source.cloneToken({ ...gitRun, installationId: 0 }, "run-42");
    const checked = await verifyGitJobToken(KEY, token, {
      repositoryId: "repo-1",
      access: "read",
    });
    expect(checked).toMatchObject({
      ok: true,
      claims: { repositoryId: "repo-1", access: "read", runId: "run-42" },
    });
    // It cannot push, and it is no good for another repository.
    expect(await verifyGitJobToken(KEY, token, { access: "write" })).toEqual({
      ok: false,
      reason: "access",
    });
    expect(await verifyGitJobToken(KEY, token, { repositoryId: "repo-2" })).toEqual({
      ok: false,
      reason: "repository",
    });
  });

  it("lasts about as long as an installation token, and no longer", async () => {
    process.env["GIT_JOB_TOKEN_KEY"] = KEY;
    const now = Date.now();
    const token = await source.cloneToken({ ...gitRun, installationId: 0 }, "run-42");
    expect((await verifyGitJobToken(KEY, token, {}, now + 59 * 60_000)).ok).toBe(true);
    expect(await verifyGitJobToken(KEY, token, {}, now + 61 * 60_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("says so when the server has no key, rather than sending a run that cannot clone", async () => {
    const run = { ...gitRun, installationId: 0 };
    await expect(source.cloneToken(run, "run-42")).rejects.toThrow(/GIT_JOB_TOKEN_KEY/);
    process.env["GIT_JOB_TOKEN_KEY"] = "too-short";
    await expect(source.cloneToken(run, "run-42")).rejects.toThrow(/GIT_JOB_TOKEN_KEY/);
    expect(source.gitJobTokenConfigured()).toBe(false);
  });

  it("is still the installation's token for a GitHub run", async () => {
    process.env["GIT_JOB_TOKEN_KEY"] = KEY;
    const run = { repoFullName: "acme/web", gitRepositoryId: null, installationId: 99 };
    expect(await source.cloneToken(run, "run-42")).toBe("installation-token-for-99");
  });
});

describe("dispatchBody for a repository on git.infrawrench.com", () => {
  it("sends a push with the forge's clone URL, owner and base", () => {
    const body = dispatchBody(
      { ...gitRun, event: "push", branch: "main", pullNumber: null, fromFork: false },
      TOKEN,
    );
    expect(body).toEqual({
      repo: "https://git.infrawrench.com/Acme/web.git",
      sha: A,
      branch: "main",
      event: "push",
      owner: "git.infrawrench.com-acme",
      "repo-id": "web",
      "default-branch": "main",
      token: TOKEN,
      base: B,
    });
  });

  it("sends a pull request of the repository itself trusted, by its pull ref", () => {
    const body = dispatchBody(
      { ...gitRun, event: "pull-request", branch: "pull/7", pullNumber: 7, fromFork: false },
      TOKEN,
    );
    expect(body).toMatchObject({
      repo: "https://git.infrawrench.com/Acme/web.git",
      ref: "refs/pull/7/head",
      branch: "pull/7",
      base: B,
      trusted: true,
    });
  });

  it("never sends a fork's pull request trusted", () => {
    const body = dispatchBody(
      { ...gitRun, event: "pull-request", branch: "pull/7", pullNumber: 7, fromFork: true },
      TOKEN,
    );
    expect(body).not.toHaveProperty("trusted");
    expect(body).not.toHaveProperty("secrets");
    expect(body).not.toHaveProperty("lent");
    expect(body["ref"]).toBe("refs/pull/7/head");
  });

  it("leaves a GitHub run's body as it was", () => {
    const body = dispatchBody(
      {
        ...gitRun,
        gitRepositoryId: null,
        repoFullName: "acme/web",
        ownerKey: "github.com-acme",
        event: "push",
        branch: "main",
        pullNumber: null,
        fromFork: false,
      },
      TOKEN,
    );
    expect(body["repo"]).toBe("https://github.com/acme/web.git");
    expect(body["owner"]).toBe("github.com-acme");
  });
});

describe("toWire", () => {
  const row = {
    id: "run-1",
    installationId: 0,
    gitRepositoryId: "repo-1" as string | null,
    repoFullName: "Acme/web",
    event: "push",
    headRef: "main",
    sha: A,
    pullNumber: null as number | null,
    headRepoFullName: null,
    fromFork: false,
    actorLogin: "octo",
    status: "passed",
    statusReason: null,
    createdAt: new Date(0),
    startedAt: null,
    finishedAt: null,
    jobs: null,
    vcpuSeconds: null,
    memoryGibSeconds: null,
    retryOfRunId: null,
    noTaskCache: false,
    pipelineFile: null,
    inputs: null,
    concurrency: null,
    cancelRequestedAt: null,
  } as unknown as Parameters<typeof toWire>[0];

  it("links a forge run to its commit there, under both names", () => {
    const wire = toWire(row);
    const url = `https://git.infrawrench.com/Acme/web/commit/${A}`;
    expect(wire.source).toBe("git");
    expect(wire.sourceUrl).toBe(url);
    // What a client from before `sourceUrl` opens.
    expect(wire.githubUrl).toBe(url);
  });

  it("links a forge pull request's run to the pull request", () => {
    const wire = toWire({ ...row, pullNumber: 7 });
    expect(wire.sourceUrl).toBe("https://git.infrawrench.com/Acme/web/pull/7");
  });

  it("answers a GitHub run as before, and says it is GitHub's", () => {
    const wire = toWire({ ...row, gitRepositoryId: null, installationId: 5, repoFullName: "a/b" });
    expect(wire.githubUrl).toBe(`https://github.com/a/b/commit/${A}`);
    expect(wire.sourceUrl).toBe(wire.githubUrl);
    expect(wire.source).toBe("github");
    expect(
      toWire({ ...row, gitRepositoryId: null, repoFullName: "a/b", pullNumber: 3 }).githubUrl,
    ).toBe("https://github.com/a/b/pull/3");
  });
});

describe("what is lent to a repository by name", () => {
  const lending = {
    id: "run-1",
    organizationId: "org-1",
    event: "push" as const,
    headRef: "main",
    fromFork: false,
  };
  const github = { ...lending, repoFullName: "acme/web" };
  const forge = { ...lending, repoFullName: "acme/web", gitRepositoryId: "repo-1" };

  it("does not reach the forge's repository of the same name", () => {
    const scope = { repos: ["acme/web"], branchPattern: null };
    expect(scopeRefusal("Production", github, scope)).toBeNull();
    expect(scopeRefusal("Production", forge, scope)).toMatch(/not lent to CI for acme\/web/);
  });

  it("reaches the forge's repository by its qualified name, and not GitHub's by it", () => {
    const scope = { repos: ["git.infrawrench.com/acme/web"], branchPattern: null };
    expect(scopeRefusal("Production", forge, scope)).toBeNull();
    expect(scopeRefusal("Production", github, scope)).not.toBeNull();
  });

  it("reaches both when lent to every repository", () => {
    const scope = { repos: null, branchPattern: null };
    expect(scopeRefusal("Production", github, scope)).toBeNull();
    expect(scopeRefusal("Production", forge, scope)).toBeNull();
  });

  it("accepts the qualified name in a repository list, and nothing else with a host", () => {
    expect(cleanRepos(["acme/web", "git.infrawrench.com/acme/web"])).toEqual([
      "acme/web",
      "git.infrawrench.com/acme/web",
    ]);
    expect(() => cleanRepos(["example.com/acme/web"])).toThrow(/Not a repository/);
    expect(() => cleanRepos(["git.infrawrench.com/acme/web/extra"])).toThrow(/Not a repository/);
  });
});
