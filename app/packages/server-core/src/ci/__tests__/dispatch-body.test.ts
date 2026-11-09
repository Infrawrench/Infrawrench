import { describe, expect, it, vi } from "vitest";

// `runs.ts` imports the database client and the GitHub App at load; the body
// builder touches neither.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { dispatchBody } = await import("../runs");

const base = {
  repoFullName: "acme/web",
  sha: "a".repeat(40),
  ownerKey: "github.com-acme",
  repoKey: "web",
  defaultBranch: "main",
  baseSha: "b".repeat(40),
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
});
