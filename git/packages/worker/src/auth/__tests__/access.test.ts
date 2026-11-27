import { describe, expect, it, vi } from "vitest";
import {
  type RepoAccessFacts,
  type RepoAccessLoaders,
  type RepoForAccess,
  accessFromPermissions,
  decideRepoAccess,
  hasAccess,
  makeRepoAccess,
} from "../access";
import type { Principal, UserPrincipal } from "../principal";

const ORG = "org_acme";
const OTHER_ORG = "org_other";
const OWNER = "user_owner";
const STRANGER = "user_stranger";

const repo = (overrides: Partial<RepoForAccess> = {}): RepoForAccess => ({
  id: "repo_1",
  visibility: "private",
  archived: false,
  owner: { kind: "org", organizationId: ORG },
  ...overrides,
});

const userRepo = (overrides: Partial<RepoForAccess> = {}): RepoForAccess =>
  repo({ owner: { kind: "user", userId: OWNER }, ...overrides });

const session = (userId: string): UserPrincipal => ({
  kind: "user",
  userId,
  via: "session",
  scopes: null,
  credentialId: null,
});

const token = (userId: string, scopes: UserPrincipal["scopes"]): UserPrincipal => ({
  kind: "user",
  userId,
  via: "token",
  scopes,
  credentialId: "tok_1",
});

const facts = (overrides: Partial<RepoAccessFacts> = {}): RepoAccessFacts => ({
  orgPermissions: [],
  collaboratorRole: null,
  ...overrides,
});

const access = (principal: Principal, target: RepoForAccess, known?: RepoAccessFacts) =>
  decideRepoAccess(principal, target, known).access;

const ANONYMOUS: Principal = { kind: "anonymous" };

describe("public and private", () => {
  it("lets anyone read a public repository and nobody without a tie read a private one", () => {
    expect(access(ANONYMOUS, repo({ visibility: "public" }))).toBe("read");
    expect(access(ANONYMOUS, repo())).toBe("none");
    expect(access(session(STRANGER), repo({ visibility: "public" }))).toBe("read");
    expect(access(session(STRANGER), repo())).toBe("none");
    expect(access(session(STRANGER), userRepo())).toBe("none");
  });

  it("never gives an anonymous caller more than read", () => {
    expect(
      access(ANONYMOUS, repo({ visibility: "public" }), facts({ orgPermissions: ["*"] })),
    ).toBe("read");
  });

  it("gives a person admin on their own namespace's repositories", () => {
    expect(access(session(OWNER), userRepo())).toBe("admin");
    expect(access(session(OWNER), userRepo({ visibility: "public" }))).toBe("admin");
  });

  it("does not let organisation permissions reach a user's repository", () => {
    // The facts loader never asks, but the decision must not care if it did.
    expect(access(session(STRANGER), userRepo(), facts({ orgPermissions: ["git:admin"] }))).toBe(
      "none",
    );
  });
});

describe("organisation roles", () => {
  it("maps git permissions to levels", () => {
    expect(accessFromPermissions([])).toBe("none");
    expect(accessFromPermissions(["resources:read", "ci:read"])).toBe("none");
    expect(accessFromPermissions(["git:read"])).toBe("read");
    expect(accessFromPermissions(["git:read", "git:write"])).toBe("write");
    expect(accessFromPermissions(["git:admin"])).toBe("admin");
  });

  it("honours wildcards the way the app's matcher does", () => {
    expect(accessFromPermissions(["*"])).toBe("admin");
    expect(accessFromPermissions(["git:*"])).toBe("admin");
    expect(accessFromPermissions(["*:read"])).toBe("read");
    // A three-segment grant does not cover a two-segment permission.
    expect(accessFromPermissions(["git:admin:extra"])).toBe("none");
  });

  it("gives members, admins and owners what their role holds", () => {
    const member = facts({ orgPermissions: ["git:read", "git:write", "ci:read"] });
    const admin = facts({ orgPermissions: ["git:read", "git:write", "git:admin"] });
    const owner = facts({ orgPermissions: ["*"] });
    const readOnly = facts({ orgPermissions: ["git:read"] });
    expect(access(session("u"), repo(), member)).toBe("write");
    expect(access(session("u"), repo(), admin)).toBe("admin");
    expect(access(session("u"), repo(), owner)).toBe("admin");
    expect(access(session("u"), repo(), readOnly)).toBe("read");
  });

  it("gives a member with no git permission nothing on a private repository", () => {
    const custom = facts({ orgPermissions: ["resources:read", "costs:read"] });
    expect(access(session("u"), repo(), custom)).toBe("none");
    expect(access(session("u"), repo({ visibility: "public" }), custom)).toBe("read");
  });
});

describe("collaborators", () => {
  it("gives a collaborator their role on a private repository", () => {
    for (const role of ["read", "triage", "write", "admin"] as const) {
      expect(access(session(STRANGER), repo(), facts({ collaboratorRole: role }))).toBe(role);
      expect(access(session(STRANGER), userRepo(), facts({ collaboratorRole: role }))).toBe(role);
    }
  });

  it("takes the higher of the role and the collaborator level, never the lower", () => {
    const member = { orgPermissions: ["git:read", "git:write"] };
    expect(access(session("u"), repo(), facts({ ...member, collaboratorRole: "read" }))).toBe(
      "write",
    );
    expect(access(session("u"), repo(), facts({ ...member, collaboratorRole: "admin" }))).toBe(
      "admin",
    );
    expect(
      access(
        session("u"),
        repo(),
        facts({ orgPermissions: ["git:read"], collaboratorRole: "triage" }),
      ),
    ).toBe("triage");
  });
});

describe("personal access tokens", () => {
  const admin = facts({ orgPermissions: ["*"] });

  it("caps a token at its scopes", () => {
    expect(access(token("u", ["repo:read"]), repo(), admin)).toBe("read");
    expect(access(token("u", ["repo:read", "repo:write"]), repo(), admin)).toBe("write");
    expect(access(token("u", ["repo:write"]), repo(), admin)).toBe("write");
  });

  it("never reaches admin with a token, even on the person's own repository", () => {
    expect(access(token(OWNER, ["repo:read", "repo:write"]), userRepo())).toBe("write");
    expect(access(token(OWNER, ["repo:read"]), userRepo())).toBe("read");
  });

  it("gives a token with no repository scope nothing private", () => {
    expect(access(token(OWNER, []), userRepo())).toBe("none");
    expect(access(token(OWNER, []), userRepo({ visibility: "public" }))).toBe("read");
  });

  it("never gives a token more than the person has", () => {
    expect(access(token(STRANGER, ["repo:write"]), repo())).toBe("none");
    expect(
      access(token("u", ["repo:write"]), repo(), facts({ orgPermissions: ["git:read"] })),
    ).toBe("read");
    expect(access(token("u", ["repo:write"]), repo(), facts({ collaboratorRole: "triage" }))).toBe(
      "triage",
    );
  });

  it("leaves a session and an SSH key uncapped", () => {
    expect(access(session("u"), repo(), admin)).toBe("admin");
    const ssh: Principal = { ...session("u"), via: "ssh-key", credentialId: "key_1" };
    expect(access(ssh, repo(), admin)).toBe("admin");
  });
});

describe("Infrawrench API keys", () => {
  const key = (permissions: string[], organizationId = ORG): Principal => ({
    kind: "api-key",
    apiKeyId: "key_1",
    organizationId,
    userId: "user_keyowner",
    permissions,
  });

  it("reaches its organisation's repositories with its own permissions", () => {
    expect(access(key(["git:read"]), repo())).toBe("read");
    expect(access(key(["git:read", "git:write"]), repo())).toBe("write");
    expect(access(key(["git:admin"]), repo())).toBe("admin");
    expect(access(key(["resources:read"]), repo())).toBe("none");
    expect(access(key([]), repo())).toBe("none");
  });

  it("reaches no other organisation's and no user's private repositories", () => {
    expect(access(key(["*"], OTHER_ORG), repo())).toBe("none");
    expect(access(key(["*"]), userRepo())).toBe("none");
    expect(access(key(["*"], OTHER_ORG), repo({ visibility: "public" }))).toBe("read");
  });

  it("ignores the facts of the key's owner", () => {
    // A key is not its owner: the owner being a collaborator elsewhere adds nothing.
    expect(
      access(key([]), repo(), facts({ orgPermissions: ["*"], collaboratorRole: "admin" })),
    ).toBe("none");
  });
});

describe("deploy keys and job tokens", () => {
  const deployKey = (readOnly: boolean, repositoryId = "repo_1"): Principal => ({
    kind: "deploy-key",
    keyId: "dk_1",
    repositoryId,
    readOnly,
  });
  const job = (write: boolean, repositoryId = "repo_1"): Principal => ({
    kind: "job",
    repositoryId,
    write,
    runId: "run_1",
  });

  it("gives a deploy key read or write on its repository", () => {
    expect(access(deployKey(true), repo())).toBe("read");
    expect(access(deployKey(false), repo())).toBe("write");
  });

  it("gives a deploy key nothing on another private repository", () => {
    expect(access(deployKey(false, "repo_2"), repo())).toBe("none");
    expect(access(deployKey(false, "repo_2"), repo({ visibility: "public" }))).toBe("read");
  });

  it("gives a job token read or write on its repository only", () => {
    expect(access(job(false), repo())).toBe("read");
    expect(access(job(true), repo())).toBe("write");
    expect(access(job(true, "repo_2"), repo())).toBe("none");
    expect(access(job(true, "repo_2"), repo({ visibility: "public" }))).toBe("read");
    // Bound to a Terraform workspace, its `write` is the state's: nothing of the repository.
    const bound: Principal = { ...job(true), workspaceId: "ws_1" } as Principal;
    expect(access(bound, repo())).toBe("none");
    expect(access({ ...job(false), workspaceId: "ws_1" } as Principal, repo())).toBe("none");
  });

  it("never gives either more than write", () => {
    const all = facts({ orgPermissions: ["*"], collaboratorRole: "admin" });
    expect(access(deployKey(false), repo(), all)).toBe("write");
    expect(access(job(true), repo(), all)).toBe("write");
  });
});

describe("archived repositories", () => {
  const archived = repo({ archived: true });
  const admin = facts({ orgPermissions: ["*"] });

  it("allows no writes, whoever asks", () => {
    const principals: Principal[] = [
      session(OWNER),
      token(OWNER, ["repo:read", "repo:write"]),
      { kind: "api-key", apiKeyId: "k", organizationId: ORG, userId: "u", permissions: ["*"] },
      { kind: "deploy-key", keyId: "dk", repositoryId: "repo_1", readOnly: false },
      { kind: "job", repositoryId: "repo_1", write: true, runId: null },
    ];
    for (const principal of principals) {
      const level = access(principal, archived, admin);
      expect(hasAccess(level, "triage"), principal.kind).toBe(false);
      expect(level, principal.kind).toBe("read");
    }
    expect(access(session(OWNER), userRepo({ archived: true }))).toBe("read");
  });

  it("does not open an archived private repository to anyone new", () => {
    expect(access(ANONYMOUS, archived)).toBe("none");
    expect(access(session(STRANGER), archived)).toBe("none");
  });

  it("keeps the level before the cap, so an administrator can unarchive", () => {
    expect(decideRepoAccess(session("u"), archived, admin)).toEqual({
      access: "read",
      unarchived: "admin",
    });
    expect(
      decideRepoAccess(session("u"), archived, facts({ orgPermissions: ["git:write"] })),
    ).toEqual({ access: "read", unarchived: "write" });
    // A token is still capped at write before the archive cap: it cannot unarchive.
    expect(decideRepoAccess(token("u", ["repo:write"]), archived, admin).unarchived).toBe("write");
  });

  it("leaves a live repository's two answers equal", () => {
    const decision = decideRepoAccess(session("u"), repo(), admin);
    expect(decision.access).toBe(decision.unarchived);
  });
});

describe("makeRepoAccess", () => {
  const loaders = (overrides: Partial<RepoAccessLoaders> = {}): RepoAccessLoaders => ({
    orgPermissions: vi.fn(async () => ["git:read", "git:write"]),
    collaboratorRole: vi.fn(async () => null),
    ...overrides,
  });

  it("is repoAccess(principal, repo)", async () => {
    const repoAccess = makeRepoAccess(loaders());
    expect(await repoAccess(session("u"), repo())).toBe("write");
    expect(await repoAccess(ANONYMOUS, repo())).toBe("none");
    expect(await repoAccess.detail(session("u"), repo({ archived: true }))).toEqual({
      access: "read",
      unarchived: "write",
    });
  });

  it("asks for the organisation's permissions and the collaborator role of a person", async () => {
    const l = loaders();
    await makeRepoAccess(l)(session("u"), repo());
    expect(l.orgPermissions).toHaveBeenCalledWith(ORG, "u", { withElevation: true });
    expect(l.collaboratorRole).toHaveBeenCalledWith("repo_1", "u");
  });

  it("keeps break-glass grants out of tokens and SSH keys", async () => {
    const l = loaders();
    await makeRepoAccess(l)(token("u", ["repo:write"]), repo());
    expect(l.orgPermissions).toHaveBeenLastCalledWith(ORG, "u", { withElevation: false });
    await makeRepoAccess(l)({ ...session("u"), via: "ssh-key" }, repo());
    expect(l.orgPermissions).toHaveBeenLastCalledWith(ORG, "u", { withElevation: false });
  });

  it("asks nothing for principals that are not people", async () => {
    const l = loaders();
    const repoAccess = makeRepoAccess(l);
    await repoAccess(ANONYMOUS, repo());
    await repoAccess({ kind: "job", repositoryId: "repo_1", write: true, runId: null }, repo());
    await repoAccess(
      { kind: "deploy-key", keyId: "k", repositoryId: "repo_1", readOnly: true },
      repo(),
    );
    await repoAccess(
      { kind: "api-key", apiKeyId: "k", organizationId: ORG, userId: "u", permissions: [] },
      repo(),
    );
    expect(l.orgPermissions).not.toHaveBeenCalled();
    expect(l.collaboratorRole).not.toHaveBeenCalled();
  });

  it("asks nothing for a person's own repository, and no organisation for a user's", async () => {
    const l = loaders();
    const repoAccess = makeRepoAccess(l);
    expect(await repoAccess(session(OWNER), userRepo())).toBe("admin");
    expect(l.collaboratorRole).not.toHaveBeenCalled();
    await repoAccess(session(STRANGER), userRepo());
    expect(l.orgPermissions).not.toHaveBeenCalled();
    expect(l.collaboratorRole).toHaveBeenCalledWith("repo_1", STRANGER);
  });

  it("gives a non-member collaborator their role on an organisation's repository", async () => {
    const repoAccess = makeRepoAccess(
      loaders({
        orgPermissions: async () => [],
        collaboratorRole: async () => "triage",
      }),
    );
    expect(await repoAccess(session(STRANGER), repo())).toBe("triage");
  });
});
