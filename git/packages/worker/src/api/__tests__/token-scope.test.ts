/**
 * What a personal token may change through the API, and the account-level
 * writes no token reaches, without a database: the repository gate is
 * replaced by a fixed repository, and the caller by a fixed principal.
 */
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  Authentication,
  Caller,
  CurrentRepository,
  Forbidden,
  RepositoryAccess,
} from "@infrawrench/git-contract";
import { fakeStorage } from "../../__tests__/helpers/fake-reader";
import type { Principal } from "../../auth/principal";
import type { RepositoryWithOwner } from "../../db/repositories";
import type { Env } from "../../env";
import { AuthRef, RepoRef, mayWriteThroughApi } from "../context";
import { RequestErrorsLive } from "../errors";
import { requireSession } from "../handlers/session";
import { maySeeAssignable } from "../handlers/settings";
import { makeGitApi } from "../server";

const env = { SITE_ORIGIN: "https://git.example.test" } as Env;
const ctx = { waitUntil: () => {} };

const REPOSITORY = {
  repository: {
    id: "repo-1",
    namespaceId: "ns-1",
    name: "infra",
    nameLower: "infra",
    visibility: "public",
    archived: false,
    defaultBranch: "main",
  },
  owner: {
    id: "ns-1",
    slug: "acme",
    kind: "org",
    userId: null,
    organizationId: "org-1",
    displayName: null,
    avatarUrl: null,
  },
} as unknown as RepositoryWithOwner;

const token = (scopes: Array<"repo:read" | "repo:write">): Principal => ({
  kind: "user",
  userId: "user-1",
  via: "token",
  scopes,
  credentialId: "token-1",
});

const session: Principal = {
  kind: "user",
  userId: "user-1",
  via: "session",
  scopes: null,
  credentialId: null,
};

/** Both gates, answering `principal` with `write` on {@link REPOSITORY}. */
const gatesAs = (principal: Principal) =>
  Layer.mergeAll(
    Layer.succeed(Authentication)((httpEffect) =>
      httpEffect.pipe(
        Effect.provideService(Caller, { userId: "user-1", username: "alice", via: "token" }),
        Effect.provideService(AuthRef, {
          principal,
          refused: false,
          setCookies: [],
          email: null,
          username: "alice",
        }),
      ),
    ),
    Layer.succeed(RepositoryAccess)((httpEffect) =>
      httpEffect.pipe(
        Effect.provideService(CurrentRepository, {
          id: "repo-1",
          namespaceId: "ns-1",
          owner: "acme",
          name: "infra",
          visibility: "public",
          archived: false,
          defaultBranch: "main",
          access: "write",
        }),
        Effect.provideService(RepoRef, { found: REPOSITORY, access: "write", unarchived: "write" }),
      ),
    ),
    RequestErrorsLive,
  );

const call = async (principal: Principal, path: string, init: RequestInit = {}) => {
  const storage = fakeStorage();
  storage.repository("repo-1").branches.set("main", "a".repeat(40));
  const response = await makeGitApi({
    middleware: gatesAs(principal),
    readers: storage.readers,
  }).handle(new Request(`https://git.example.test${path}`, init), env, ctx);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
};

const createBranch = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "topic", from: "main" }),
};

describe("a personal token's scopes on API writes", () => {
  it("lets a token without repo:write read and change nothing", async () => {
    expect((await call(token(["repo:read"]), "/api/repos/acme/infra/refs")).status).toBe(200);
    for (const scopes of [["repo:read"], []] as const) {
      const refused = await call(
        token([...scopes]),
        "/api/repos/acme/infra/branches",
        createBranch,
      );
      expect(refused.status, scopes.join(",")).toBe(403);
      expect(refused.body).toMatchObject({ error: expect.stringContaining("repo:write") });
    }
  });

  it("leaves a repo:write token and a session to the endpoint's own rules", async () => {
    for (const principal of [token(["repo:read", "repo:write"]), session]) {
      const answer = await call(principal, "/api/repos/acme/infra/branches", createBranch);
      // Past the scope check: what answers now is the handler (here without a database).
      expect(answer.body).not.toMatchObject({ error: expect.stringContaining("repo:write") });
    }
  });

  it("is a rule on the principal alone", () => {
    expect(mayWriteThroughApi(token(["repo:read"]))).toBe(false);
    expect(mayWriteThroughApi(token([]))).toBe(false);
    expect(mayWriteThroughApi(token(["repo:write"]))).toBe(true);
    expect(mayWriteThroughApi(session)).toBe(true);
    expect(mayWriteThroughApi({ ...session, via: "ssh-key", credentialId: "key-1" })).toBe(true);
    expect(mayWriteThroughApi({ kind: "anonymous" })).toBe(true);
  });
});

describe("a username, which no token changes", () => {
  it("is claimed and renamed from a session only", () => {
    expect(() => requireSession({ principal: session })).not.toThrow();
    for (const principal of [token(["repo:read", "repo:write"]), token([])]) {
      expect(() => requireSession({ principal })).toThrow(Forbidden);
    }
    expect(() => requireSession({ principal: { kind: "anonymous" } })).toThrow(Forbidden);
  });
});

describe("who may list the people a thread can be assigned to", () => {
  const viewerIn = (organizationIds: string[]) => async () =>
    ({ organizations: organizationIds.map((id) => ({ id })) }) as never;
  const cx = (
    access: "read" | "triage",
    organizationIds: string[],
    userId: string | null = "user-1",
  ) => ({ userId, access, repo: REPOSITORY, viewer: viewerIn(organizationIds) });

  it("answers someone who can assign, and the owning organisation's members", async () => {
    expect(await maySeeAssignable(cx("triage", []))).toBe(true);
    expect(await maySeeAssignable(cx("read", ["org-1"]))).toBe(true);
  });

  it("does not hand an organisation's membership to a reader of its public repository", async () => {
    expect(await maySeeAssignable(cx("read", []))).toBe(false);
    expect(await maySeeAssignable(cx("read", ["org-2"]))).toBe(false);
    expect(await maySeeAssignable(cx("read", ["org-1"], null))).toBe(false);
  });
});
