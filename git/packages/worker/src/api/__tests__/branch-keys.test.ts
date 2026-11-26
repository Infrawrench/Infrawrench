/**
 * A branch page's key in an API path is one percent-encoded segment
 * (`feature%2Fa%2Fb`). These run requests through the real API handler
 * (`makeGitApi`) with the resolver replaced, to prove the router hands the
 * handlers the decoded key, and that a key naming nothing is the 404 a
 * missing page is.
 */
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Authentication,
  Caller,
  CurrentRepository,
  RepositoryAccess,
} from "@infrawrench/git-contract";
import { fakeStorage } from "../../__tests__/helpers/fake-reader";
import type { RepositoryWithOwner } from "../../db/repositories";
import type { Env } from "../../env";
import { RepoRef } from "../context";
import { RequestErrorsLive } from "../errors";
import { makeGitApi } from "../server";

const asked: string[] = [];

vi.mock("../../db/branch-pages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/branch-pages")>();
  return {
    ...actual,
    // Records the key a handler resolved, and finds no page for it.
    resolveBranchKey: async (_repositoryId: string, key: string) => {
      asked.push(key);
      return null;
    },
  };
});

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
    isFork: false,
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

const api = () => {
  const storage = fakeStorage();
  storage.repository("repo-1").branches.set("main", "a".repeat(40));
  return makeGitApi({ middleware: TestGates, readers: storage.readers });
};

const get = async (path: string) => {
  const response = await api().handle(new Request(`https://git.example.test${path}`), env, ctx);
  return { status: response.status, body: (await response.json()) as unknown };
};

afterEach(() => {
  asked.length = 0;
});

describe("a branch page's key in an API path", () => {
  it("reaches the handler decoded: `feature%2Fa%2Fb` is the branch `feature/a/b`", async () => {
    expect(await get("/api/repos/acme/infra/branches/feature%2Fa%2Fb")).toEqual({
      status: 404,
      body: { error: "No such branch page" },
    });
    expect(asked).toEqual(["feature/a/b"]);
  });

  it("decodes a fork's key and an ordinal on every page endpoint alike", async () => {
    await get("/api/repos/acme/infra/branches/bob%2Finfra%3Afeature%2Fa~2/versions");
    await get("/api/repos/acme/infra/branches/-%3Afix~1/findings");
    await get("/api/repos/acme/infra/branches/feature%2Fa/agent");
    expect(asked).toEqual(["bob/infra:feature/a~2", "-:fix~1", "feature/a"]);
  });

  it("answers a key that names no page as the 404 of a missing page", async () => {
    for (const key of ["~2", "a:b:c", "bob%2F:x", "main"]) {
      const answer = await get(`/api/repos/acme/infra/branches/${key}`);
      expect(answer.status, key).toBe(404);
      expect(answer.body, key).toEqual({ error: "No such branch page" });
    }
  });
});
