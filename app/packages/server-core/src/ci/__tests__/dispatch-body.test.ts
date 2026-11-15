import { describe, expect, it, vi } from "vitest";

// `runs.ts` imports the database client and the GitHub App at load; the body
// builder touches neither.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { dispatchBody, inputProblemText, manualBranchRefusal, retryRefusal } =
  await import("../runs");

const base = {
  repoFullName: "acme/web",
  sha: "a".repeat(40),
  ownerKey: "github.com-acme",
  repoKey: "web",
  defaultBranch: "main",
  baseSha: "b".repeat(40),
  noTaskCache: false,
  pipelineText: null,
  pipelineFile: null,
  inputs: null,
};
// Obviously fake, and in no real token format.
const TOKEN = "installation-token-for-tests";

describe("dispatchBody", () => {
  it("sends a push without `trusted`, which the proxy runs with secrets", () => {
    const body = dispatchBody(
      { ...base, event: "push", branch: "main", pullNumber: null, baseSha: null, fromFork: false },
      TOKEN,
    );
    expect(body).toEqual({
      repo: "https://github.com/acme/web.git",
      sha: base.sha,
      branch: "main",
      event: "push",
      owner: "github.com-acme",
      "repo-id": "web",
      "default-branch": "main",
      token: TOKEN,
    });
  });

  it("sends a push the commit it moved the branch from, for `paths:` to diff against", () => {
    const body = dispatchBody(
      { ...base, event: "push", branch: "main", pullNumber: null, fromFork: false },
      TOKEN,
    );
    expect(body).toMatchObject({ event: "push", base: base.baseSha });
    // Still a push: no pull request ref, and nothing to vouch for.
    expect(body).not.toHaveProperty("ref");
    expect(body).not.toHaveProperty("trusted");
  });

  it("sends a scheduled run with its one pipeline's text, on the default branch", () => {
    const body = dispatchBody(
      {
        ...base,
        event: "schedule",
        branch: "main",
        pullNumber: null,
        baseSha: null,
        fromFork: false,
        pipelineText: "name: Nightly",
      },
      TOKEN,
    );
    expect(body).toEqual({
      repo: "https://github.com/acme/web.git",
      sha: base.sha,
      branch: "main",
      event: "schedule",
      owner: "github.com-acme",
      "repo-id": "web",
      "default-branch": "main",
      token: TOKEN,
      pipeline: "name: Nightly",
    });
  });

  it("vouches for a pull request from the repository itself", () => {
    const body = dispatchBody(
      { ...base, event: "pull-request", branch: "pull/4", pullNumber: 4, fromFork: false },
      TOKEN,
    );
    expect(body).toMatchObject({
      branch: "pull/4",
      ref: "refs/pull/4/head",
      base: base.baseSha,
      trusted: true,
    });
  });

  it("never vouches for a fork's pull request, approved or not", () => {
    const body = dispatchBody(
      { ...base, event: "pull-request", branch: "pull/9", pullNumber: 9, fromFork: true },
      TOKEN,
    );
    expect(body).not.toHaveProperty("trusted");
    expect(body).not.toHaveProperty("secrets");
    // Its own cache scope, so it cannot poison a branch's caches.
    expect(body).toMatchObject({ branch: "pull/9", ref: "refs/pull/9/head" });
  });

  it("asks the runner to skip the task cache only for a run that does", () => {
    const push = {
      ...base,
      event: "push" as const,
      branch: "main",
      pullNumber: null,
      baseSha: null,
      fromFork: false,
    };
    // Unasked, the field is absent: a runner that predates it refuses it.
    expect(dispatchBody(push, TOKEN)).not.toHaveProperty("no-task-cache");
    expect(dispatchBody({ ...push, noTaskCache: true }, TOKEN)).toMatchObject({
      "no-task-cache": true,
    });
  });

  it("never vouches for a fork's pull request retried without the task cache", () => {
    const body = dispatchBody(
      {
        ...base,
        event: "pull-request",
        branch: "pull/9",
        pullNumber: 9,
        fromFork: true,
        noTaskCache: true,
      },
      TOKEN,
    );
    expect(body).not.toHaveProperty("trusted");
    expect(body).toMatchObject({ "no-task-cache": true, branch: "pull/9" });
  });
});

describe("dispatchBody for a manual run", () => {
  const manual = {
    ...base,
    event: "manual" as const,
    branch: "feature/x",
    pullNumber: null,
    baseSha: null,
    fromFork: false,
    pipelineFile: ".infrawrench/ci/purge.yml",
  };

  it("runs the one file it was started for on its branch, with its inputs as data", () => {
    const inputs = { urls: "$(touch /tmp/pwned)\n'; rm -rf /", force: "true" };
    const body = dispatchBody({ ...manual, inputs }, TOKEN);
    expect(body).toEqual({
      repo: "https://github.com/acme/web.git",
      sha: base.sha,
      branch: "feature/x",
      event: "manual",
      owner: "github.com-acme",
      "repo-id": "web",
      "default-branch": "main",
      token: TOKEN,
      "pipeline-file": ".infrawrench/ci/purge.yml",
      inputs,
    });
    // A branch of the repository itself: trusted like a push, so nothing
    // to vouch for and no pull request ref.
    expect(body).not.toHaveProperty("trusted");
    expect(body).not.toHaveProperty("ref");
    expect(body).not.toHaveProperty("pipeline");
  });

  it("leaves out inputs it was not given, and never sends either field for another event", () => {
    expect(dispatchBody({ ...manual, inputs: {} }, TOKEN)).not.toHaveProperty("inputs");
    const push = dispatchBody(
      { ...manual, event: "push", inputs: { a: "b" }, branch: "main" },
      TOKEN,
    );
    expect(push).not.toHaveProperty("inputs");
    expect(push).not.toHaveProperty("pipeline-file");
  });
});

describe("manualBranchRefusal", () => {
  it("takes Git branch names and refuses anything else", () => {
    for (const ok of ["main", "feature/x", "release-1.2", "dependabot/npm/a-1.0"]) {
      expect(manualBranchRefusal(ok)).toBeNull();
    }
    for (const bad of [
      "",
      "a..b",
      "-rf",
      "refs/heads/main",
      "a b",
      "a\nb",
      "x~1",
      "x^",
      "x:y",
      "a//b",
      "/a",
      "a/",
      "a.lock",
      "a@{1}",
    ]) {
      expect(manualBranchRefusal(bad), bad).toMatch(/is not a branch name/);
    }
  });
});

describe("inputProblemText", () => {
  it("names the input and what it takes", () => {
    expect(inputProblemText("note", { kind: "required" })).toBe("note is required.");
    expect(inputProblemText("zone", { kind: "choice", options: ["www", "docs"] })).toBe(
      "zone is one of www, docs.",
    );
    expect(inputProblemText("x", { kind: "unknown" })).toBe("The pipeline declares no input x.");
  });
});

describe("retryRefusal", () => {
  it("retries finished runs only, never one waiting for approval", () => {
    expect(retryRefusal({ status: "passed" })).toBeNull();
    expect(retryRefusal({ status: "failed" })).toBeNull();
    expect(retryRefusal({ status: "error" })).toBeNull();
    // A cancelled run (by a person, or a newer run of its group) retries too.
    expect(retryRefusal({ status: "cancelled" })).toBeNull();
    expect(retryRefusal({ status: "pending" })).toMatch(/not finished/);
    expect(retryRefusal({ status: "awaiting_approval" })).toMatch(/approve it instead/);
    expect(retryRefusal({ status: "rejected" })).toMatch(/rejected/);
    expect(retryRefusal({ status: "queued" })).toMatch(/not finished/);
    expect(retryRefusal({ status: "running" })).toMatch(/not finished/);
  });
});
