/**
 * The API served without a database: a fixed caller on a fixed repository
 * (the two gates replaced), a `RepoReader` fake, and the real routing,
 * decoding, encoding and error rendering. What these prove is the wiring:
 * content handlers go through the reader, its refusals become the API's
 * errors, and nothing answers a private shape it should not.
 *
 * The gates themselves, and everything that reads Postgres, are
 * `src/__tests__/db/`.
 */
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { describe, expect, it } from "vitest";
import {
  Authentication,
  Caller,
  CurrentRepository,
  GitApi,
  RepositoryAccess,
  UnprocessableEntity,
} from "@infrawrench/git-contract";
import { fakeStorage } from "../../__tests__/helpers/fake-reader";
import type { Authenticated } from "../../auth/authenticate";
import { ANONYMOUS } from "../../auth/principal";
import type { RepositoryWithOwner } from "../../db/repositories";
import type { Env } from "../../env";
import { repoReaderFor } from "../../repo/select";
import { type Invocation, InvocationRef, RepoRef } from "../context";
import { RequestErrorsLive } from "../errors";
import { ContentsHandlers } from "../handlers/contents";
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

/** The two gates, answering a fixed anonymous reader of {@link REPOSITORY}. */
const TestGates = Layer.mergeAll(
  Layer.succeed(Authentication)((httpEffect) =>
    Effect.provideService(httpEffect, Caller, { userId: null, username: null, via: "anonymous" }),
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
        access: "read",
      }),
      Effect.provideService(RepoRef, { found: REPOSITORY, access: "read", unarchived: "read" }),
    ),
  ),
  RequestErrorsLive,
);

const anonymous: Authenticated = {
  principal: ANONYMOUS,
  refused: false,
  setCookies: [],
  email: null,
};

const storage = () => {
  const fake = fakeStorage();
  const repo = fake.repository("repo-1");
  repo.branches.set("main", "a".repeat(40));
  repo.files.set("README.md", "# infra\n");
  repo.files.set("modules/vpc/main.tf", "resource {}\n");
  return fake;
};

describe("the contents group through the in-memory client", () => {
  const fake = storage();
  const invocation: Invocation = {
    env,
    request: new Request("https://git.example.test/"),
    waitUntil: () => {},
    scope: undefined,
    readers: fake.readers,
    authenticate: async () => anonymous,
    cookies: [],
  };
  const makeClient = HttpApiTest.groups(GitApi, ["contents"]);
  const run = <A, E>(
    use: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, E>,
  ): Promise<A> =>
    Effect.gen(function* () {
      return yield* use(yield* makeClient);
    }).pipe(
      Effect.provideService(InvocationRef, invocation),
      // The gates are provided with `provideMerge`: the pipeline resolves
      // them again when it builds the routes.
      Effect.provide(
        Layer.merge(ContentsHandlers.pipe(Layer.provideMerge(TestGates)), HttpServer.layerServices),
      ),
      Effect.scoped,
      Effect.runPromise,
    );
  const params = { owner: "acme", repo: "infra" };

  it("answers refs with the repository row's default branch", async () => {
    const refs = await run((client) => client.contents.listRefs({ params, query: {} }));
    expect(refs).toEqual({
      defaultBranch: "main",
      branches: [{ name: "main", oid: "a".repeat(40) }],
      tags: [],
      branchesTruncated: false,
      tagsTruncated: false,
    });
  });

  it("serves a file and its README through the reader", async () => {
    const blob = await run((client) =>
      client.contents.blob({ params, query: { path: "README.md" } }),
    );
    expect(blob.text).toBe("# infra\n");
    expect(blob.ref).toMatchObject({ kind: "branch", name: "main" });
    const { readme } = await run((client) => client.contents.readme({ params, query: {} }));
    expect(readme?.path).toBe("README.md");
  });

  it("refuses a directory asked for as a file with the declared 422", async () => {
    const error = await run((client) =>
      client.contents.blob({ params, query: { path: "modules" } }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(UnprocessableEntity);
    expect(error).toMatchObject({ code: "not_a_file" });
  });
});

describe("the API as a fetch handler", () => {
  const api = (readers = storage().readers) => makeGitApi({ middleware: TestGates, readers });
  const get = async (handler: ReturnType<typeof api>, path: string, init?: RequestInit) => {
    const response = await handler.handle(
      new Request(`https://git.example.test${path}`, init),
      env,
      ctx,
    );
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
  };

  it("answers 503 for content while the storage has no implementation", async () => {
    const handler = makeGitApi({ middleware: TestGates, readers: repoReaderFor });
    for (const path of ["/refs", "/tree", "/blob?path=a", "/commits", "/branches", "/tags"]) {
      const { status, body } = await get(handler, `/api/repos/acme/infra${path}`);
      expect(status, path).toBe(503);
      expect(body, path).toEqual({ error: "Repository contents are not available right now" });
    }
  });

  it("turns each reader refusal into the API's own error", async () => {
    const handler = api();
    expect(await get(handler, "/api/repos/acme/infra/blob?path=nope")).toEqual({
      status: 404,
      body: { error: "No such path", code: "path_not_found" },
    });
    expect(await get(handler, "/api/repos/acme/infra/blob?path=a&ref=gone")).toEqual({
      status: 404,
      body: { error: "No such branch, tag or commit", code: "ref_not_found" },
    });
    // A ref a query named for a comparison is the query's fault.
    expect(await get(handler, "/api/repos/acme/infra/compare/diff?base=main&head=gone")).toEqual({
      status: 422,
      body: { error: "No such branch, tag or commit", code: "ref_not_found" },
    });
  });

  it("answers a request that fails its schema with the 400 and its issues", async () => {
    const { status, body } = await get(api(), "/api/repos/acme/infra/commits?limit=0");
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "Invalid request" });
    expect((body as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it("answers its own 404 for a path under /api that nothing routes", async () => {
    expect(await get(api(), "/api/nothing/here")).toEqual({
      status: 404,
      body: { error: "Not found" },
    });
  });

  it("answers HEAD as the GET without its body", async () => {
    const response = await api().handle(
      new Request("https://git.example.test/api/repos/acme/infra/refs", { method: "HEAD" }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("says nothing of the server in a 500", async () => {
    const readers: typeof repoReaderFor = () => ({
      ...repoReaderFor(env, { id: "", owner: "", name: "" }),
      listRefs: () => Promise.reject(new Error("pack repos/x/secret-path is corrupt")),
    });
    const { status, body } = await get(api(readers), "/api/repos/acme/infra/refs");
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("secret-path");
    expect(body).toMatchObject({ error: "Internal server error" });
  });
});

describe("the gates, where they need no database", () => {
  const live = (authenticate: () => Promise<Authenticated>) => makeGitApi({ authenticate });
  const call = async (
    handler: ReturnType<typeof live>,
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown; cookies: string[] }> => {
    const response = await handler.handle(
      new Request(`https://git.example.test${path}`, init),
      env,
      ctx,
    );
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      cookies: response.headers.getSetCookie(),
    };
  };

  it("answers session.me to a signed-out browser, never a 401", async () => {
    const { status, body } = await call(
      live(async () => anonymous),
      "/api/session",
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      user: null,
      onboarding: null,
      organizations: [],
      signInUrl: "/auth/sign-in",
    });
  });

  it("answers 401 to a credential that was refused, whatever the endpoint", async () => {
    const handler = live(async () => ({ ...anonymous, refused: true }));
    for (const path of ["/api/session", "/api/explore/repos"]) {
      const { status, body } = await call(handler, path);
      expect(status, path).toBe(401);
      expect(body).toMatchObject({ code: "sign_in_required" });
    }
  });

  it("answers 401 where a signed-in person is needed, before the payload is read", async () => {
    const handler = live(async () => anonymous);
    const created = await call(handler, "/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Not a valid payload: the gate answers first.
      body: JSON.stringify({ nonsense: true }),
    });
    expect(created.status).toBe(401);
    expect((await call(handler, "/api/user/tokens")).status).toBe(401);
    expect((await call(handler, "/api/user/repos")).status).toBe(401);
  });

  it("keeps credentials to a session: an API key cannot list or mint them", async () => {
    const handler = live(async () => ({
      ...anonymous,
      principal: {
        kind: "api-key" as const,
        apiKeyId: "key-1",
        organizationId: "org-1",
        userId: "user-1",
        permissions: ["*"],
      },
    }));
    expect((await call(handler, "/api/user/keys")).status).toBe(403);
  });

  it("puts a refreshed session's cookie on the answer, a refusal included", async () => {
    const handler = live(async () => ({ ...anonymous, setCookies: ["iwg-session=new; Path=/"] }));
    expect((await call(handler, "/api/session")).cookies).toEqual(["iwg-session=new; Path=/"]);
    expect((await call(handler, "/api/user/keys")).cookies).toEqual(["iwg-session=new; Path=/"]);
  });
});
