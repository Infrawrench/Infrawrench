/**
 * Link previews against a real Postgres: what `og/lookup.ts` reads for each
 * kind of page, as a signed-out visitor, and that a private repository and
 * everything in it reads exactly as a missing one does, down to the tags'
 * bytes and the image's version.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GitPushEvent } from "../../env";
import { handlePush } from "../../events/consumer";
import { lookupFacts } from "../../og/lookup";
import { cardOf, cardVersion, pageMeta } from "../../og/meta";
import { pageOf } from "../../og/pages";
import { shellEdits } from "../../og/shell";
import type { RepoReaderFactory } from "../../repo/select";
import { RepoReaderError } from "../../repo/reader";
import { db } from "../../db/client";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ZERO = "0".repeat(40);
const ORIGIN = "https://git.example.test";

describe.skipIf(!configured)("link previews, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person;
  let pub: { id: string; path: string }, priv: { id: string; path: string };
  let reader: RepoReaderFactory;

  /** A branch pushed as a push does, which opens its page. */
  const push = async (repoId: string, branch: string) => {
    const newOid = world.storage.nextOid();
    world.storage.commits.set(newOid, { message: "Raise the alarm", email: alice.email });
    const oldOid = world.storage.moveBranch(repoId, branch, newOid, { at: Date.now() }) ?? ZERO;
    const event: GitPushEvent = {
      type: "push",
      repoId,
      actor: { kind: "user", userId: alice.id, credentialId: null },
      updates: [{ name: `refs/heads/${branch}`, oldOid, newOid, forced: false }],
      at: Date.now(),
    };
    await handlePush(event, world.env, world.storage.readers);
    return newOid;
  };

  const facts = (path: string) => lookupFacts(pageOf(path), { env: world.env, reader });
  /** The tags and the image version a page gets. */
  const preview = async (path: string) => {
    const found = await facts(path);
    return {
      tags: JSON.stringify(shellEdits(await pageMeta(pageOf(path), found, ORIGIN))),
      version: await cardVersion(cardOf(found).card),
    };
  };

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob] = (await Promise.all(["alice", "bob"].map((name) => world.person(name)))) as [
      Person,
      Person,
    ];
    pub = await world.repository(alice, alice.username, "pub", "public");
    priv = await world.repository(alice, alice.username, "priv", "private");
    // The fake storage has no single-commit read: this one knows the commits pushed here.
    reader = (env, locator) => {
      const inner = world.storage.readers(env, locator);
      return {
        ...inner,
        commit: async (sha: string) => {
          const [commit] = await inner.commits([sha]);
          if (!commit) throw new RepoReaderError("ref_not_found", "No such commit");
          return {
            commit: {
              ...commit,
              treeOid: ZERO,
              message: commit.summary,
              committerUser: null,
              signed: false,
            },
            stats: { filesChanged: 2, additions: 10, deletions: 3 },
            files: [],
            filesTruncated: false,
            branches: [],
            tags: [],
          };
        },
      };
    };
    for (const repo of [pub, priv]) {
      await world.call("PATCH", repo.path, {
        as: alice,
        body: { description: 'Budgets "and" <alarms>' },
      });
      await world.call("POST", `${repo.path}/issues`, {
        as: alice,
        body: { title: "The alarm fires at 80 percent" },
      });
      await world.call("PUT", `${repo.path}/star`, { as: bob });
    }
  });
  afterAll(() => world?.cleanup());

  it("reads a public repository as its page shows it", async () => {
    const found = await facts(`/${alice.username}/pub`);
    expect(found).toMatchObject({
      kind: "repository",
      repository: {
        owner: alice.username,
        name: "pub",
        description: 'Budgets "and" <alarms>',
        defaultBranch: "main",
        stars: 1,
      },
    });
  });

  it("reads a private repository as a missing one, on every page of it", async () => {
    const owner = alice.username;
    for (const tail of [
      "",
      "/issues",
      "/issues/1",
      "/commit/abcdef1",
      "/branches/feature/a",
      "/pulls/1",
    ]) {
      const hidden = await preview(`/${owner}/priv${tail}`);
      const missing = await preview(`/${owner}/no-such-repo${tail}`);
      expect(hidden, tail).toEqual(missing);
      expect(await facts(`/${owner}/priv${tail}`), tail).toBeNull();
    }
    // And as the site's own preview.
    expect(await preview(`/${owner}/priv`)).toEqual(await preview("/settings"));
  });

  it("reads an issue, and not a branch page's number as one", async () => {
    const found = await facts(`/${alice.username}/pub/issues/1`);
    expect(found).toMatchObject({
      kind: "issue",
      number: 1,
      title: "The alarm fires at 80 percent",
      state: "open",
      comments: 0,
    });
    expect(await facts(`/${alice.username}/pub/issues/999`)).toBeNull();
  });

  it("reads a branch page by its key and by its old number", async () => {
    await push(pub.id, "fix/alarm");
    const byKey = await facts(`/${alice.username}/pub/branches/fix/alarm`);
    expect(byKey).toMatchObject({
      kind: "branch",
      key: "fix/alarm",
      // A page a push opens is a draft until someone says otherwise.
      state: "draft",
      headRef: "fix/alarm",
      baseRef: "main",
      findings: { mustFix: 0, shouldFix: 0, note: 0 },
    });
    if (byKey?.kind !== "branch") throw new Error("not a branch page");
    const number = (
      await world.call("GET", `${pub.path}/branch-pages?state=all&head=fix/alarm`, { as: alice })
    ).body.items[0].number as number;
    const byNumber = await facts(`/${alice.username}/pub/pulls/${number}`);
    expect(byNumber).toEqual(byKey);
    expect(await facts(`/${alice.username}/pub/issues/${number}`)).toBeNull();
    expect(await facts(`/${alice.username}/pub/branches/no-such-branch`)).toBeNull();
  });

  it("never opens a page for a branch that has none", async () => {
    await world.storage
      .readers(world.env, { id: pub.id, owner: alice.username, name: "pub" })
      .createBranch({ name: "quiet", from: "main", actor: null })
      .catch(() => undefined);
    const before = await db.execute("select count(*)::int as n from git_pull_requests");
    expect(await facts(`/${alice.username}/pub/branches/quiet`)).toBeNull();
    const after = await db.execute("select count(*)::int as n from git_pull_requests");
    expect(after).toEqual(before);
  });

  it("reads a commit from the storage, and a missing one as nothing", async () => {
    const oid = await push(pub.id, "fix/commit");
    expect(await facts(`/${alice.username}/pub/commit/${oid}`)).toMatchObject({
      kind: "commit",
      sha: oid,
      summary: "Raise the alarm",
      filesChanged: 2,
    });
    expect(await facts(`/${alice.username}/pub/commit/${"e".repeat(40)}`)).toBeNull();
  });

  it("counts only a namespace's public repositories", async () => {
    expect(await facts(`/${alice.username}`)).toMatchObject({
      kind: "namespace",
      slug: alice.username,
      namespaceKind: "user",
      repositories: 1,
    });
    expect(await facts("/no-such-namespace-at-all")).toBeNull();
    expect(await facts("/claude")).toMatchObject({ namespaceKind: "bot", repositories: null });
  });
});
