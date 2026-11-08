import { describe, expect, it } from "vitest";
import { ownerKey, parseCiEvent, repoKey } from "../events";

const sha = (c: string) => c.repeat(40);
const repo = { full_name: "acme/web", default_branch: "main" };

describe("parseCiEvent", () => {
  it("reads branch pushes and ignores deletions and tags", () => {
    const push = {
      installation: { id: 7 },
      repository: repo,
      ref: "refs/heads/feature/x",
      after: sha("a"),
      sender: { login: "octo" },
    };
    expect(parseCiEvent("push", push)).toEqual({
      kind: "push",
      installationId: 7,
      repoFullName: "acme/web",
      branch: "feature/x",
      sha: sha("a"),
      defaultBranch: "main",
      actorLogin: "octo",
    });
    expect(parseCiEvent("push", { ...push, deleted: true })).toBeNull();
    expect(parseCiEvent("push", { ...push, ref: "refs/tags/v1" })).toBeNull();
    expect(parseCiEvent("push", { ...push, after: "nope" })).toBeNull();
    expect(parseCiEvent("push", { ...push, installation: {} })).toBeNull();
  });

  const pr = (head: unknown, action = "opened") => ({
    action,
    installation: { id: 7 },
    repository: repo,
    sender: { login: "contributor" },
    pull_request: {
      number: 12,
      head,
      base: { sha: sha("b"), repo: { full_name: "acme/web" } },
    },
  });

  it("tells a fork's pull request from a branch's", () => {
    const own = parseCiEvent(
      "pull_request",
      pr({ sha: sha("c"), ref: "fix", repo: { full_name: "acme/web" } }),
    );
    expect(own).toMatchObject({
      kind: "pull_request",
      number: 12,
      fromFork: false,
      headRef: "fix",
    });
    const fork = parseCiEvent(
      "pull_request",
      pr({ sha: sha("c"), ref: "main", repo: { full_name: "mallory/web" } }),
    );
    expect(fork).toMatchObject({ fromFork: true, headRepoFullName: "mallory/web" });
    // A deleted fork has no head repository: still a fork.
    expect(parseCiEvent("pull_request", pr({ sha: sha("c"), ref: "x", repo: null }))).toMatchObject(
      { fromFork: true },
    );
    // Case does not make a fork.
    expect(
      parseCiEvent(
        "pull_request",
        pr({ sha: sha("c"), ref: "x", repo: { full_name: "ACME/Web" } }),
      ),
    ).toMatchObject({ fromFork: false });
  });

  it("only runs for new code", () => {
    const head = { sha: sha("c"), ref: "fix", repo: { full_name: "acme/web" } };
    for (const action of ["opened", "synchronize", "reopened"]) {
      expect(parseCiEvent("pull_request", pr(head, action))).not.toBeNull();
    }
    for (const action of ["closed", "labeled", "edited", "assigned"]) {
      expect(parseCiEvent("pull_request", pr(head, action))).toBeNull();
    }
    expect(parseCiEvent("issues", pr(head))).toBeNull();
  });

  it("names owners and repositories as the runner does", () => {
    expect(ownerKey("Acme/Web")).toBe("github.com-acme");
    expect(repoKey("Acme/Web")).toBe("web");
  });
});
