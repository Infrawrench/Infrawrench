/**
 * The API's content routes over the real reader and a real history, in
 * Node: the fetch handler with its two gates replaced (as
 * `src/api/__tests__/handlers.test.ts` does), `src/repo/queries` in place of
 * the fake reader, and a repository pushed by `git`. Only routes that need
 * no database are here; `test/e2e/reader.test.ts` runs the same ones through
 * workerd and the Durable Object.
 */
import {
  Authentication,
  Caller,
  CurrentRepository,
  RepositoryAccess,
} from "@infrawrench/git-contract";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RepoRef } from "../src/api/context";
import { RequestErrorsLive } from "../src/api/errors";
import { type GitApiHandler, makeGitApi } from "../src/api/server";
import type { RepositoryWithOwner } from "../src/db/repositories";
import type { Env } from "../src/env";
import { ReaderState, localRepoReader } from "../src/repo/queries";
import { cleanupTempDirs, commitFile, git, gitOut, hasGit, initRepo } from "./support/git";
import { type NodeRepo, startNodeRepo } from "./support/node-server";

afterAll(cleanupTempDirs);

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

describe.skipIf(!hasGit)("the API's content routes over real storage", () => {
  let repo: NodeRepo;
  let api: GitApiHandler;
  let work: string;
  let first: string;
  let second: string;

  const get = async (path: string): Promise<{ status: number; body: any }> => {
    const response = await api.handle(
      new Request(`https://git.example.test/api/repos/acme/infra${path}`),
      { SITE_ORIGIN: "https://git.example.test" } as Env,
      { waitUntil: () => {} },
    );
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  };

  beforeAll(async () => {
    repo = await startNodeRepo("repo-1");
    const state = new ReaderState();
    api = makeGitApi({
      middleware: TestGates,
      readers: (_env, locator) => localRepoReader(repo.repository, state, locator),
    });
    work = await initRepo("api");
    await commitFile(work, "README.md", "# infra\n", "add a readme");
    first = await commitFile(work, "modules/vpc/main.tf", 'resource "a" "b" {}\n', "add a vpc");
    await git(["checkout", "-q", "-b", "wider"], { cwd: work });
    second = await commitFile(
      work,
      "modules/vpc/main.tf",
      'resource "a" "b" {\n  cidr = "10.0.0.0/8"\n}\n',
      "vpc: a wider range",
    );
    await git(["push", "-q", repo.url, "--all"], { cwd: work });
  });
  afterAll(async () => {
    expect(repo.errors).toEqual([]);
    await repo.close();
  });

  it("answers 503 before the storage exists, then the repository's own content", async () => {
    const empty = await startNodeRepo("repo-1");
    const none = makeGitApi({
      middleware: TestGates,
      readers: (_env, locator) => localRepoReader(empty.repository, new ReaderState(), locator),
    });
    const response = await none.handle(
      new Request("https://git.example.test/api/repos/acme/infra/refs"),
      {} as Env,
      { waitUntil: () => {} },
    );
    expect(response.status).toBe(503);
    await empty.close();

    expect((await get("/refs")).body).toEqual({
      defaultBranch: "main",
      branches: [
        { name: "main", oid: first },
        { name: "wider", oid: second },
      ],
      tags: [],
      branchesTruncated: false,
      tagsTruncated: false,
    });
  });

  it("serves a file, the README and the diffs in the contract's shapes", async () => {
    const blob = await get("/blob?path=modules/vpc/main.tf&ref=wider");
    expect(blob.status).toBe(200);
    expect(blob.body).toMatchObject({
      path: "modules/vpc/main.tf",
      name: "main.tf",
      text: 'resource "a" "b" {\n  cidr = "10.0.0.0/8"\n}\n',
      lineCount: 3,
      rawUrl: `/acme/infra/raw/${second}/modules/vpc/main.tf`,
      ref: { name: "wider", kind: "branch", fullName: "refs/heads/wider", commitOid: second },
    });
    expect(blob.body.oid).toBe(
      await gitOut(["rev-parse", "wider:modules/vpc/main.tf"], { cwd: work }),
    );
    expect((await get("/readme")).body.readme).toMatchObject({
      path: "README.md",
      text: "# infra\n",
    });
    expect((await get("/readme?path=modules")).body).toEqual({ readme: null });

    const diff = await get(`/commits/${second}/diff`);
    expect(diff.body).toMatchObject({
      baseOid: first,
      headOid: second,
      stats: { filesChanged: 1, additions: 3, deletions: 1 },
      nextCursor: null,
    });
    expect(diff.body.files[0]).toMatchObject({
      path: "modules/vpc/main.tf",
      status: "modified",
      additions: 3,
      deletions: 1,
      binary: false,
      tooLarge: false,
    });
    const compared = await get("/compare/diff?base=main&head=wider&context=0");
    expect(compared.body.files[0].hunks[0].lines).toEqual([
      { type: "delete", content: 'resource "a" "b" {}', oldLine: 1, newLine: null },
      { type: "add", content: 'resource "a" "b" {', oldLine: null, newLine: 1 },
      { type: "add", content: '  cidr = "10.0.0.0/8"', oldLine: null, newLine: 2 },
      { type: "add", content: "}", oldLine: null, newLine: 3 },
    ]);
  });

  it("turns the storage's refusals into the API's errors", async () => {
    expect(await get("/blob?path=nope")).toMatchObject({
      status: 404,
      body: { code: "path_not_found" },
    });
    expect(await get("/blob?path=modules")).toMatchObject({
      status: 422,
      body: { code: "not_a_file" },
    });
    expect((await get("/blob?path=README.md&ref=gone")).status).toBe(404);
    expect((await get("/compare/diff?base=main&head=gone")).status).toBe(422);
    expect((await get(`/commits/${"e".repeat(40)}/diff`)).status).toBe(404);
  });
});
