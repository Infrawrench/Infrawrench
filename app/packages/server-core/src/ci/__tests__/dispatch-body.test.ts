import { describe, expect, it, vi } from "vitest";

// `runs.ts` imports the database client and the GitHub App at load; the body
// builder touches neither.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { dispatchBody, retryRefusal } = await import("../runs");

const base = {
  repoFullName: "acme/web",
  sha: "a".repeat(40),
  ownerKey: "github.com-acme",
  repoKey: "web",
  defaultBranch: "main",
  baseSha: "b".repeat(40),
  noTaskCache: false,
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
