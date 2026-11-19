import { describe, expect, it } from "vitest";
import { ownerKey, parseCheckRerequest, parseCiEvent, repoKey, runIdOfExternalId } from "../events";

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
      baseSha: null,
      defaultBranch: "main",
      actorLogin: "octo",
    });
    expect(parseCiEvent("push", { ...push, deleted: true })).toBeNull();
    expect(parseCiEvent("push", { ...push, ref: "refs/tags/v1" })).toBeNull();
    expect(parseCiEvent("push", { ...push, after: "nope" })).toBeNull();
    expect(parseCiEvent("push", { ...push, installation: {} })).toBeNull();
  });

  it("gives a push the commit it moved the branch from, when the two compare", () => {
    const push = {
      installation: { id: 7 },
      repository: repo,
      ref: "refs/heads/main",
      before: sha("c"),
      after: sha("a"),
      created: false,
      forced: false,
    };
    const base = (body: unknown) => {
      const ev = parseCiEvent("push", body);
      return ev?.kind === "push" ? ev.baseSha : undefined;
    };
    expect(base(push)).toBe(sha("c"));
    // A new branch has no earlier commit: GitHub sends forty zeros.
    expect(base({ ...push, before: sha("0"), created: true })).toBeNull();
    expect(base({ ...push, before: sha("0") })).toBeNull();
    // A force push's old head may be unreachable, and is not what changed.
    expect(base({ ...push, forced: true })).toBeNull();
    expect(base({ ...push, before: "nope" })).toBeNull();
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

describe("parseCheckRerequest", () => {
  const RUN = "0f8c6c2e-5b1a-4c6e-9d2f-3a4b5c6d7e8f";
  const checkRun = (action = "rerequested", extra: Record<string, unknown> = {}) => ({
    action,
    installation: { id: 7 },
    repository: repo,
    sender: { login: "octo" },
    check_run: {
      id: 901,
      head_sha: sha("a"),
      external_id: `${RUN}:Test:build`,
      app: { id: 42 },
      check_suite: { id: 55, head_branch: "feature/x" },
      ...extra,
    },
  });
  const checkSuite = (action = "rerequested", extra: Record<string, unknown> = {}) => ({
    action,
    installation: { id: 7 },
    repository: repo,
    sender: { login: "octo" },
    check_suite: { id: 55, head_sha: sha("a"), head_branch: "main", app: { id: 42 }, ...extra },
  });

  it("reads a re-run of one check, with its app, commit and external id", () => {
    expect(parseCheckRerequest("check_run", checkRun())).toEqual({
      kind: "check_run",
      installationId: 7,
      repoFullName: "acme/web",
      appId: 42,
      headSha: sha("a"),
      headBranch: "feature/x",
      checkRunId: 901,
      externalId: `${RUN}:Test:build`,
      senderLogin: "octo",
    });
  });

  it("reads a re-run of a commit's whole suite", () => {
    expect(parseCheckRerequest("check_suite", checkSuite())).toEqual({
      kind: "check_suite",
      installationId: 7,
      repoFullName: "acme/web",
      appId: 42,
      headSha: sha("a"),
      headBranch: "main",
      checkRunId: null,
      externalId: null,
      senderLogin: "octo",
    });
    // A fork's commit: GitHub knows no branch of this repository for it.
    expect(
      parseCheckRerequest("check_suite", checkSuite("rerequested", { head_branch: null })),
    ).toMatchObject({ headBranch: null });
  });

  it("starts nothing for other actions, events or a malformed delivery", () => {
    for (const action of ["created", "completed", "requested_action"]) {
      expect(parseCheckRerequest("check_run", checkRun(action))).toBeNull();
    }
    for (const action of ["requested", "completed"]) {
      expect(parseCheckRerequest("check_suite", checkSuite(action))).toBeNull();
    }
    expect(parseCheckRerequest("push", checkRun())).toBeNull();
    expect(parseCheckRerequest("check_run", checkRun("rerequested", { app: null }))).toBeNull();
    expect(parseCheckRerequest("check_run", checkRun("rerequested", { head_sha: "x" }))).toBeNull();
    expect(parseCheckRerequest("check_suite", { ...checkSuite(), installation: {} })).toBeNull();
    expect(parseCheckRerequest("check_suite", null)).toBeNull();
  });

  it("reads GitHub's ghost sender as nobody", () => {
    expect(
      parseCheckRerequest("check_run", { ...checkRun(), sender: { login: "ghost" } }),
    ).toMatchObject({ senderLogin: null });
  });

  it("finds the run in a run's or a job's external id", () => {
    expect(runIdOfExternalId(RUN)).toBe(RUN);
    expect(runIdOfExternalId(`${RUN}:Test:build`)).toBe(RUN);
    expect(runIdOfExternalId(`${RUN.toUpperCase()}:a:b`)).toBe(RUN);
    expect(runIdOfExternalId("something-else")).toBeNull();
    expect(runIdOfExternalId("")).toBeNull();
    expect(runIdOfExternalId(null)).toBeNull();
  });
});
