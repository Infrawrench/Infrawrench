/**
 * What names a branch's page, against a real Postgres: the key a page is
 * given (`feature`, `feature~1` for an earlier page of a reused name,
 * `owner/name:feature` for a fork's branch, `-:feature` once that fork is
 * gone), the page each key resolves to, `branches.locate`, proposing with
 * the defaults, and a private repository that answers as missing through
 * all of it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GitPushEvent } from "../../env";
import { handlePush } from "../../events/consumer";
import { type Person, type World, configured, makeWorld, pagePath } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ZERO = "0".repeat(40);

describe.skipIf(!configured)("branch page keys, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person;
  let repo: string;
  let id: string;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, carol] = (await Promise.all(
      ["alice", "bob", "carol"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
    const made = await world.repository(alice, alice.username, "keys", "public");
    repo = made.path;
    id = made.id;
  });
  afterAll(() => world?.cleanup());

  /** Move a branch as a push does and deliver its event, or delete it. */
  const push = async (branch: string, options: { delete?: boolean } = {}) => {
    const newOid = options.delete ? ZERO : world.storage.nextOid();
    if (!options.delete)
      world.storage.commits.set(newOid, { message: "A change", email: alice.email });
    const oldOid =
      world.storage.moveBranch(id, branch, options.delete ? null : newOid, { at: Date.now() }) ??
      ZERO;
    const event: GitPushEvent = {
      type: "push",
      repoId: id,
      actor: { kind: "user", userId: alice.id, credentialId: null },
      updates: [{ name: `refs/heads/${branch}`, oldOid, newOid, forced: false }],
      at: Date.now(),
    };
    await handlePush(event, world.env, world.storage.readers);
  };
  const pagesOf = async (branch: string) =>
    (
      (await world.call("GET", `${repo}/branch-pages?state=all&head=${branch}`, { as: alice })).body
        .items as Array<Record<string, any>>
    ).sort((a, b) => a["number"] - b["number"]);
  const get = (key: string, as: Person | undefined = alice) =>
    world.call("GET", pagePath(repo, key), { as });

  it("numbers a reused name's earlier pages, and gives the bare name to the open one", async () => {
    await push("reused");
    const [first] = await pagesOf("reused");
    expect(first).toMatchObject({ key: "reused", state: "open" });
    await world.call("POST", `${pagePath(repo, "reused")}/close`, { as: alice });
    // Deleted and pushed again: a new lineage, so a new page.
    await push("reused", { delete: true });
    await push("reused");
    const [older, newer] = await pagesOf("reused");
    expect(older).toMatchObject({ number: first!["number"], key: "reused~1", state: "closed" });
    expect(newer).toMatchObject({ key: "reused", state: "open" });
    expect((await get("reused")).body.number).toBe(newer!["number"]);
    expect((await get("reused~1")).body.number).toBe(older!["number"]);
    expect((await get("reused~2")).body.number).toBe(newer!["number"]);
    expect((await get("reused~3")).status).toBe(404);

    // None open: the bare name is the newest.
    await world.call("POST", `${pagePath(repo, "reused")}/close`, { as: alice });
    expect((await pagesOf("reused")).map((page) => page["key"])).toEqual(["reused~1", "reused"]);
    // The older one reopened is the open one, so the bare name moves to it, even past a newer one.
    expect(
      (await world.call("POST", `${pagePath(repo, "reused~1")}/reopen`, { as: alice })).body,
    ).toMatchObject({ key: "reused", state: "open", number: older!["number"] });
    expect((await pagesOf("reused")).map((page) => page["key"])).toEqual(["reused", "reused~2"]);
    expect((await get("reused")).body.number).toBe(older!["number"]);

    // A thread number finds the key its page has now.
    expect(
      (await world.call("GET", `${repo}/branch-pages/${newer!["number"]}`, { as: bob })).body,
    ).toEqual({ key: "reused~2" });
    const issue = (
      await world.call("POST", `${repo}/issues`, { as: bob, body: { title: "An issue" } })
    ).body;
    expect((await world.call("GET", `${repo}/branch-pages/${issue.number}`)).status).toBe(404);
    expect((await world.call("GET", `${repo}/branch-pages/9999`)).status).toBe(404);

    // A mention names the page by the key it has now.
    await world.call("POST", `${repo}/issues/${older!["number"]}/comments`, {
      as: bob,
      body: { body: `Same as #${issue.number}` },
    });
    const mention = (
      await world.call("GET", `${repo}/issues/${issue.number}/timeline`, { as: bob })
    ).body.items.find((item: Record<string, any>) => item["type"] === "cross_referenced");
    expect(mention.source).toMatchObject({ number: older!["number"], branch: "reused" });
  });

  it("answers a key that names nothing as a missing page", async () => {
    for (const key of [
      "~1",
      "a:b:c",
      "x/:feature",
      "/y:feature",
      "nobody/none:reused",
      "-:reused",
    ]) {
      expect((await get(key)).status, key).toBe(404);
    }
  });

  it("proposes with the defaults: the default branch, and the branch's name as a title", async () => {
    world.storage.repository(id).branches.set("fix/slow-login", world.storage.nextOid());
    const proposed = await world.call("POST", `${repo}/branch-pages`, {
      as: bob,
      body: { head: "fix/slow-login" },
    });
    expect(proposed).toMatchObject({
      status: 200,
      body: { key: "fix/slow-login", baseRef: "main", title: "Slow login", draft: false },
    });
    expect((await get("fix/slow-login")).body.number).toBe(proposed.body.number);
  });

  it("names a fork's page by the fork, and by `-:` once the fork is gone", async () => {
    const fork = await world.call("POST", `${repo}/forks`, {
      as: bob,
      body: { owner: bob.username, name: "keys-fork" },
    });
    expect(fork.status).toBe(200);
    const forkId = fork.body.id as string;
    world.storage
      .repository(forkId)
      .branches.set("main", world.storage.repository(id).branches.get("main")!);
    world.storage.repository(forkId).branches.set("feature/x", world.storage.nextOid());
    // Bob proposes the fork's branch to its parent: the page is the parent's.
    const proposed = await world.call("POST", `${repo}/branch-pages`, {
      as: bob,
      body: { head: "feature/x", headRepository: `${bob.username}/keys-fork` },
    });
    expect(proposed.status).toBe(200);
    const key = `${bob.username}/keys-fork:feature/x`;
    expect(proposed.body).toMatchObject({ key, crossRepository: true });
    expect((await get(key, carol)).body.number).toBe(proposed.body.number);
    // A branch of the same name in the parent is another page entirely.
    expect((await get("feature/x", carol)).status).toBe(404);
    expect(
      await world.call("POST", `${repo}/branch-pages`, {
        as: bob,
        body: { head: "feature/x", headRepository: `${bob.username}/keys-fork` },
      }),
    ).toMatchObject({ status: 409, body: { code: "branch_page_exists" } });

    const deleted = await world.call(
      "DELETE",
      `/api/repos/${bob.username}/keys-fork?confirm=${encodeURIComponent(`${bob.username}/keys-fork`)}`,
      { as: bob },
    );
    expect(deleted.status).toBe(200);
    expect((await get(key, carol)).status).toBe(404);
    const gone = await get("-:feature/x", carol);
    expect(gone).toMatchObject({ status: 200, body: { key: "-:feature/x", headRepository: null } });
    expect(gone.body.number).toBe(proposed.body.number);
  });

  it("keeps a private repository's pages, keys and branches as missing as the repository", async () => {
    const made = await world.repository(alice, alice.username, "hidden", "private");
    world.storage.repository(made.id).branches.set("secret-plan", world.storage.nextOid());
    const missing = await world.call(
      "GET",
      `/api/repos/${alice.username}/no-such-repo/branches/x`,
      {
        as: carol,
      },
    );
    expect(missing.status).toBe(404);
    for (const path of [
      pagePath(made.path, "secret-plan"),
      `${made.path}/branch-pages/1`,
      `${made.path}/branch-pages`,
    ]) {
      for (const as of [carol, undefined]) {
        const answer = await world.call("GET", path, { as });
        expect([path, answer.status, answer.body]).toEqual([path, 404, missing.body]);
      }
    }
    // Nothing was opened by those reads; its owner reading it opens the page.
    expect(
      (await world.call("GET", `${made.path}/branch-pages?state=all`, { as: alice })).body.items,
    ).toEqual([]);
    expect(
      (await world.call("GET", pagePath(made.path, "secret-plan"), { as: alice })).body,
    ).toMatchObject({
      key: "secret-plan",
      draft: true,
    });
  });

  it("opens a public repository's page for a reader who is not signed in, as nobody's", async () => {
    world.storage.repository(id).branches.set("read-first", world.storage.nextOid());
    const read = await world.call("GET", pagePath(repo, "read-first"));
    expect(read).toMatchObject({
      status: 200,
      body: { key: "read-first", author: null, draft: true },
    });
  });
});
