import { SERVICE_TOKEN_PURPOSE } from "@infrawrench/git-terraform";
import { describe, expect, it } from "vitest";
import { type RepoAccessDecision, type RepoForAccess, decideRepoAccess } from "../../auth/access";
import type { Principal } from "../../auth/principal";
import { decidePlanAccess, decideStateAuth, stateHolder } from "../access";

const REPOSITORY = "repo_1";
const WORKSPACE = "ws_1";

const repo = (over: Partial<RepoForAccess> = {}): RepoForAccess => ({
  id: REPOSITORY,
  visibility: "private",
  archived: false,
  owner: { kind: "org", organizationId: "org_1" },
  ...over,
});

/** What the organisation's roles give: every member writes, an administrator administers. */
const PERMISSIONS: Record<string, readonly string[]> = {
  admin: ["git:admin"],
  member: ["git:write"],
  viewer: ["git:read"],
  stranger: [],
};

const person = (
  userId: string,
  scopes: readonly ("repo:read" | "repo:write")[] | null = null,
): Principal => ({
  kind: "user",
  userId,
  via: scopes === null ? "session" : "token",
  scopes,
  credentialId: scopes === null ? null : `pat_${userId}`,
});

const job = (over: Partial<Extract<Principal, { kind: "job" }>> = {}): Principal => ({
  kind: "job",
  repositoryId: REPOSITORY,
  write: false,
  runId: "ci_1",
  workspaceId: WORKSPACE,
  ...over,
});

/** As the directory does: `repoAccess` for the credential, and for whoever is behind it. */
const decide = (principal: Principal, target = repo(), liveRun = false) => {
  const detail = (who: Principal): RepoAccessDecision | null =>
    who.kind === "job"
      ? null
      : decideRepoAccess(who, target, {
          orgPermissions: who.kind === "user" ? (PERMISSIONS[who.userId] ?? []) : [],
          collaboratorRole: null,
        });
  const { principal: _name, ...may } = decideStateAuth(principal, {
    repositoryId: REPOSITORY,
    workspaceId: WORKSPACE,
    access: detail(principal),
    holder: detail(stateHolder(principal)),
    liveRun,
  });
  return may;
};

const NOTHING = { canRead: false, canLock: false, canWrite: false, canAdmin: false };
const USE = { canRead: true, canLock: true, canWrite: true, canAdmin: false };

describe("who may use a workspace's state", () => {
  it("is the repository's administrators, not everyone who writes it", () => {
    expect(decide(person("admin"))).toEqual({ ...USE, canAdmin: true });
    // Every member of an organisation has `git:write` on every repository.
    expect(decide(person("member"))).toEqual(NOTHING);
    expect(decide(person("viewer"))).toEqual(NOTHING);
    expect(decide(person("stranger"))).toEqual(NOTHING);
    expect(decide({ kind: "anonymous" })).toEqual(NOTHING);
    // Public changes who reads the code, never who reads the state.
    for (const who of ["member", "viewer", "stranger"]) {
      expect(decide(person(who), repo({ visibility: "public" })), who).toEqual(NOTHING);
    }
  });

  it("takes an administrator's token with repo:write, and never lets a token administer", () => {
    expect(decide(person("admin", ["repo:write"]))).toEqual(USE);
    expect(decide(person("admin", ["repo:read", "repo:write"]))).toEqual(USE);
    expect(decide(person("admin", ["repo:read"]))).toEqual(NOTHING);
    expect(decide(person("admin", []))).toEqual(NOTHING);
    // The token of someone who only writes is as they are.
    expect(decide(person("member", ["repo:write"]))).toEqual(NOTHING);
  });

  it("takes an API key by its own permissions", () => {
    const key = (permissions: readonly string[]): Principal => ({
      kind: "api-key",
      apiKeyId: "key_1",
      organizationId: "org_1",
      userId: "admin",
      permissions,
    });
    expect(decide(key(["git:admin"]))).toEqual({ ...USE, canAdmin: true });
    expect(decide(key(["git:write"]))).toEqual(NOTHING);
    expect(decide({ ...key(["git:admin"]), organizationId: "org_2" } as Principal)).toEqual(
      NOTHING,
    );
  });

  it("never takes a deploy key", () => {
    expect(
      decide({ kind: "deploy-key", keyId: "k", repositoryId: REPOSITORY, readOnly: false }),
    ).toEqual(NOTHING);
  });

  it("reads an archived repository's state and changes nothing", () => {
    const archived = repo({ archived: true });
    expect(decide(person("admin"), archived)).toEqual({ ...NOTHING, canRead: true });
    expect(decide(person("admin", ["repo:write"]), archived)).toEqual({
      ...NOTHING,
      canRead: true,
    });
    expect(decide(person("member"), archived)).toEqual(NOTHING);
  });

  it("gives a run's token its own workspace while the run is live", () => {
    // A plan reads and locks; an apply writes too. Neither administers.
    expect(decide(job(), repo(), true)).toEqual({ ...USE, canWrite: false });
    expect(decide(job({ write: true }), repo(), true)).toEqual(USE);
    expect(decide(job({ write: true }), repo(), false)).toEqual(NOTHING);
  });

  it("refuses a job token that is not for this workspace, whatever else it is", () => {
    for (const other of [
      // What a Terraform run used to get: `write` on the repository, no workspace.
      job({ write: true, workspaceId: null }),
      { kind: "job", repositoryId: REPOSITORY, write: true, runId: "ci_1" } as Principal,
      job({ write: true, workspaceId: "ws_2" }),
      job({ write: true, workspaceId: "" }),
      job({ write: true, repositoryId: "repo_2" }),
    ]) {
      expect(decide(other, repo(), true), JSON.stringify(other)).toEqual(NOTHING);
      expect(decide(other, repo({ visibility: "public" }), true)).toEqual(NOTHING);
    }
  });

  it("lets the app's own token read the workspace it names and nothing else", () => {
    const service = job({ runId: SERVICE_TOKEN_PURPOSE });
    expect(decide(service)).toEqual({ ...NOTHING, canRead: true });
    // `write` on it means nothing: it is no run's.
    expect(decide(job({ runId: SERVICE_TOKEN_PURPOSE, write: true }), repo(), true)).toEqual({
      ...NOTHING,
      canRead: true,
    });
    expect(decide(job({ runId: SERVICE_TOKEN_PURPOSE, workspaceId: null }))).toEqual(NOTHING);
    expect(decide(job({ runId: SERVICE_TOKEN_PURPOSE, workspaceId: "ws_2" }))).toEqual(NOTHING);
  });

  it("asks about the person behind a token, and about nobody else's credential", () => {
    const token = person("admin", ["repo:write"]);
    expect(stateHolder(token)).toEqual({ ...token, scopes: null });
    for (const same of [person("admin"), job(), { kind: "anonymous" } as Principal]) {
      expect(stateHolder(same)).toBe(same);
    }
  });
});

describe("who may post or read a run's plan", () => {
  const facts = { repositoryId: REPOSITORY, workspaceId: WORKSPACE, liveRunId: "tf_1" };

  it("is the run's own job, with a plan's token or an apply's", () => {
    expect(decidePlanAccess(job(), facts, "tf_1")).toEqual({ kind: "job", ciRunId: "ci_1" });
    expect(decidePlanAccess(job({ write: true }), facts, "tf_1")).toEqual({
      kind: "job",
      ciRunId: "ci_1",
    });
    expect(decidePlanAccess(job(), facts, "tf_2")).toEqual({ kind: "none" });
    expect(decidePlanAccess(job(), { ...facts, liveRunId: null }, "tf_1")).toEqual({
      kind: "none",
    });
  });

  it("is nobody without this workspace's claim", () => {
    for (const other of [
      person("admin"),
      person("admin", ["repo:write"]),
      job({ write: true, workspaceId: null }),
      job({ write: true, workspaceId: "ws_2" }),
      job({ write: true, repositoryId: "repo_2" }),
      job({ runId: SERVICE_TOKEN_PURPOSE, workspaceId: null }),
    ]) {
      expect(decidePlanAccess(other, facts, "tf_1"), JSON.stringify(other)).toEqual({
        kind: "none",
      });
    }
  });

  it("lets the app read what it will price, for the workspace its token names", () => {
    expect(decidePlanAccess(job({ runId: SERVICE_TOKEN_PURPOSE }), facts, "tf_1")).toEqual({
      kind: "service",
    });
  });
});
