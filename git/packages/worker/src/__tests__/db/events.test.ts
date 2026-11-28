/**
 * The queue consumer against a real Postgres. A queue delivers at least
 * once, so every push here is handled twice and must leave what one
 * delivery leaves.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gitPullRequests, gitTerraformRuns } from "@infrawrench/server-core/db/schema";
import { db } from "../../db/client";
import type { GitPushEvent } from "../../env";
import { announcePullRequest, announcePush } from "../../events/ci";
import { handlePush } from "../../events/consumer";
import { type Person, type World, configured, makeWorld, pagePath } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ZERO = "0".repeat(40);

describe.skipIf(!configured)("the push consumer, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person;
  let repo: string;
  let id: string;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob] = (await Promise.all(["alice", "bob"].map((name) => world.person(name)))) as [
      Person,
      Person,
    ];
    const made = await world.repository(alice, alice.username, "pushed");
    repo = made.path;
    id = made.id;
    await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });
  });
  afterAll(() => world?.cleanup());
  beforeEach(() => {
    vi.mocked(announcePush).mockClear();
    vi.mocked(announcePullRequest).mockClear();
  });

  /** Move a branch in the storage and deliver its push event twice. */
  const push = async (
    branch: string,
    options: { forced?: boolean; delete?: boolean; messages?: string[]; by?: Person } = {},
  ) => {
    const storage = world.storage.repository(id);
    const oldOid = storage.branches.get(branch) ?? ZERO;
    const commits = (options.messages ?? ["A change"]).map((message) => {
      const oid = world.storage.nextOid();
      world.storage.commits.set(oid, { message, email: (options.by ?? alice).email });
      return oid;
    });
    const newOid = options.delete ? ZERO : commits.at(-1)!;
    if (options.delete) storage.branches.delete(branch);
    else {
      storage.branches.set(branch, newOid);
      world.storage.ranges.set(newOid, commits);
    }
    const event: GitPushEvent = {
      type: "push",
      repoId: id,
      actor: { kind: "user", userId: (options.by ?? alice).id, credentialId: null },
      updates: [{ name: `refs/heads/${branch}`, oldOid, newOid, forced: options.forced ?? false }],
      at: Date.now(),
    };
    await handlePush(event, world.env, world.storage.readers);
    await handlePush(event, world.env, world.storage.readers);
    return { oldOid, newOid, commits };
  };
  const timeline = async (number: number) =>
    (await world.call("GET", `${repo}/issues/${number}/timeline?limit=100`)).body.items as Array<
      Record<string, any>
    >;

  it("records the push on the repository row", async () => {
    const before = (await world.call("GET", repo)).body;
    await push("main");
    const after = (await world.call("GET", repo)).body;
    expect(after).toMatchObject({ sizeBytes: 2048, branchCount: 1, isEmpty: false });
    expect(Date.parse(after.pushedAt)).toBeGreaterThanOrEqual(Date.parse(before.pushedAt));
    // CI is told of every ref, each delivery; its own dedupe key makes the second harmless.
    expect(vi.mocked(announcePush)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(announcePush).mock.calls[0]?.[2]).toBe(alice.username);
  });

  it("synchronises a pull request whose head moved, once", async () => {
    await push("feature");
    const pull = (
      await world.call("POST", `${repo}/branch-pages`, {
        as: bob,
        body: { title: "Feature", base: "main", head: "feature" },
      })
    ).body;
    await world.call("POST", `${repo}/protected-branches`, {
      as: alice,
      body: { pattern: "main", requiredApprovals: 1, dismissStaleApprovals: true },
    });
    await world.call("POST", `${pagePath(repo, pull.key)}/reviews`, {
      as: alice,
      body: { event: "approve" },
    });
    expect((await world.call("GET", `${pagePath(repo, pull.key)}`)).body.reviewDecision).toBe(
      "approved",
    );
    vi.mocked(announcePullRequest).mockClear();

    const moved = await push("feature", { messages: ["One", "Two"], by: bob });
    const synced = (await world.call("GET", `${pagePath(repo, pull.key)}`)).body;
    expect(synced.headOid).toBe(moved.newOid);
    // The approval was of the older head, and the rule dismisses those.
    expect(synced.reviewDecision).toBe("review_required");
    expect(world.storage.repository(id).pullRefs.get(pull.number)).toBe(moved.newOid);

    const entries = await timeline(pull.number);
    const pushed = entries.filter((entry) => entry.type === "commits");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!["commits"].map((commit: { oid: string }) => commit.oid)).toEqual(
      moved.commits,
    );
    expect(pushed[0]!["commits"][0].authorUser.username).toBe(bob.username);
    // CI hears `synchronize` for the base repository, with the head's own repository named.
    const [base, announced, action, head, actor] = vi.mocked(announcePullRequest).mock.calls[0]!;
    expect(base.repository.id).toBe(id);
    expect(announced.pull.headOid).toBe(moved.newOid);
    expect([action, head?.repository.id, actor]).toEqual(["synchronize", id, bob.username]);

    const forced = await push("feature", { forced: true });
    const after = await timeline(pull.number);
    expect(after.filter((entry) => entry.type === "head_force_pushed")).toEqual([
      expect.objectContaining({ beforeOid: moved.newOid, afterOid: forced.newOid }),
    ]);

    // Deleted without its changes in main: the page closes with it.
    await push("feature", { delete: true });
    const gone = (await world.call("GET", `${pagePath(repo, pull.key)}`, { as: bob })).body;
    expect(gone).toMatchObject({ headRefExists: false, state: "closed" });
    expect(gone.mergeability.blockers.map((b: { code: string }) => b.code)).toEqual(["closed"]);
    expect(
      (await timeline(pull.number))
        .map((entry) => entry.type)
        .filter((type) => type === "head_branch_deleted" || type === "closed"),
    ).toEqual(["head_branch_deleted", "closed"]);
  });

  /** A branch pushed and given a page against main, as the forge opens one. */
  const page = async (branch: string, by: Person = bob) => {
    const pushed = await push(branch, { by });
    const opened = (
      await world.call("POST", `${repo}/branch-pages`, {
        as: by,
        body: { title: branch, base: "main", head: branch },
      })
    ).body;
    return { ...pushed, key: opened.key as string, number: opened.number as number };
  };
  const pageOf = async (key: string) =>
    (await world.call("GET", `${pagePath(repo, key)}`, { as: alice })).body;

  it("merges the pages whose changes a push to main brought in, and deletes their branches", async () => {
    const squashed = await page("squashed");
    const merged = await page("merged");
    const waiting = await page("waiting");
    const kept = await page("kept");
    await world.call("POST", `${repo}/protected-branches`, {
      as: alice,
      body: { pattern: "kept", allowDeletion: false },
    });
    world.storage.landings.set(squashed.newOid, "applied");
    world.storage.landings.set(merged.newOid, "contained");
    world.storage.landings.set(kept.newOid, "applied");
    const branches = world.storage.repository(id).branches;

    const main = await push("main", { by: alice });

    const squashedPage = await pageOf(squashed.key);
    expect(squashedPage).toMatchObject({
      state: "merged",
      mergeMethod: "squash",
      mergeCommitOid: main.newOid,
      headRefExists: false,
    });
    expect(squashedPage.mergedBy.username).toBe(alice.username);
    expect(branches.has("squashed")).toBe(false);
    expect(await pageOf(merged.key)).toMatchObject({ state: "merged", mergeMethod: "merge" });
    expect(branches.has("merged")).toBe(false);
    // Nothing of it in main: open, and its branch is left alone.
    expect((await pageOf(waiting.key)).state).toBe("open");
    expect(branches.get("waiting")).toBe(waiting.newOid);
    // A protection rule that keeps the branch keeps it; the page is still merged.
    expect((await pageOf(kept.key)).state).toBe("merged");
    expect(branches.get("kept")).toBe(kept.newOid);

    // Delivered twice, recorded once.
    const entries = (await timeline(squashed.number)).map((entry) => entry.type);
    expect(entries.filter((type) => type === "merged")).toHaveLength(1);
    expect(entries.filter((type) => type === "head_branch_deleted")).toHaveLength(1);
  });

  it("deletes a merged branch only where it was measured", async () => {
    const moving = await page("moving");
    world.storage.landings.set(moving.newOid, "applied");
    // The branch moves in the storage after the page last heard of it.
    const ahead = world.storage.nextOid();
    world.storage.repository(id).branches.set("moving", ahead);
    await push("main", { by: alice });
    expect((await pageOf(moving.key)).state).toBe("merged");
    expect(world.storage.repository(id).branches.get("moving")).toBe(ahead);
  });

  it("merges a page left open after its branch went, at the next push to main", async () => {
    // As pages were before a deleted branch closed them: open, the branch gone.
    const left = await page("left-open");
    world.storage.repository(id).branches.delete("left-open");
    await db
      .update(gitPullRequests)
      .set({ headRefExists: false })
      .where(and(eq(gitPullRequests.repositoryId, id), eq(gitPullRequests.headRef, "left-open")));
    world.storage.landings.set(left.newOid, "applied");
    await push("main", { by: alice });
    expect(await pageOf(left.key)).toMatchObject({ state: "merged", headRefExists: false });
    expect((await timeline(left.number)).map((entry) => entry.type)).not.toContain(
      "head_branch_deleted",
    );
  });

  it("records a page as merged when its branch is deleted after its changes landed", async () => {
    const done = await page("done-elsewhere");
    world.storage.landings.set(done.newOid, "applied");
    await push("done-elsewhere", { delete: true, by: alice });
    const gone = await pageOf(done.key);
    expect(gone).toMatchObject({ state: "merged", mergeMethod: "squash", headRefExists: false });
    expect(
      (await timeline(done.number)).map((entry) => entry.type).filter((type) => type !== "commits"),
    ).toEqual(["merged", "head_branch_deleted"]);
  });

  it("closes the issues a commit on the default branch fixes, and notes the ones it names", async () => {
    const open = async (title: string) =>
      (await world.call("POST", `${repo}/issues`, { as: bob, body: { title } })).body
        .number as number;
    const [fixed, named, untouched] = [
      await open("Fixed"),
      await open("Named"),
      await open("Other"),
    ];

    // On another branch a commit says, and does, nothing.
    await push("side", { messages: [`Fixes #${fixed}`] });
    expect((await world.call("GET", `${repo}/issues/${fixed}`)).body.state).toBe("open");

    const landed = await push("main", {
      messages: [`Tidy up\n\nFixes #${fixed}. See #${named}.`, `Again for #${fixed}`],
    });
    const closed = (await world.call("GET", `${repo}/issues/${fixed}`)).body;
    expect(closed).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(closed.closedBy.username).toBe(alice.username);
    expect(
      (await timeline(fixed)).map((entry) => [entry.type, entry.commitOid ?? entry.commit?.oid]),
    ).toEqual([
      ["referenced", landed.commits[0]],
      ["referenced", landed.commits[1]],
      ["closed", landed.commits[0]],
    ]);
    expect((await world.call("GET", `${repo}/issues/${named}`)).body.state).toBe("open");
    expect((await timeline(named)).map((entry) => entry.type)).toEqual(["referenced"]);
    expect(await timeline(untouched)).toEqual([]);
    expect((await world.call("GET", `${repo}/issues?state=closed`)).body.items).toHaveLength(1);
  });

  it("keeps a workspace in a personal namespace, and runs nothing for it", async () => {
    const created = await world.call("POST", `${repo}/terraform/workspaces`, {
      as: alice,
      body: { name: "prod", rootPath: "/infra/" },
    });
    expect(created.body).toMatchObject({
      name: "prod",
      rootPath: "infra",
      branch: "main",
      planOnBranch: true,
      applyOnMerge: true,
      applyRequiresApproval: true,
      stateAddress: `https://git.example.test/${alice.username}/pushed/terraform/prod/state`,
    });
    expect(
      await world.call("POST", `${repo}/terraform/workspaces`, {
        as: alice,
        body: { name: "prod", rootPath: "" },
      }),
    ).toMatchObject({ status: 409 });
    expect(
      (
        await world.call("POST", `${repo}/terraform/workspaces`, {
          as: bob,
          body: { name: "x", rootPath: "" },
        })
      ).status,
    ).toBe(403);

    // A personal namespace has the state backend only: a pull request and a
    // merge record no run (`terraform.test.ts` has an organisation's).
    await push("plan-me");
    await world.call("POST", `${repo}/branch-pages`, {
      as: bob,
      body: { title: "Infra", base: "main", head: "plan-me" },
    });
    await push("plan-me");
    await push("main");
    expect((await world.call("GET", `${repo}/terraform/runs?limit=100`)).body.items).toEqual([]);
    expect(
      await db.select().from(gitTerraformRuns).where(eq(gitTerraformRuns.repositoryId, id)),
    ).toEqual([]);
  });

  it("does nothing for a repository that has been deleted since", async () => {
    await handlePush(
      { type: "push", repoId: "no-such-repository", actor: null, updates: [], at: Date.now() },
      world.env,
      world.storage.readers,
    );
  });
});
