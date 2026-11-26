/**
 * The queue consumer against a real Postgres. A queue delivers at least
 * once, so every push here is handled twice and must leave what one
 * delivery leaves.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gitTerraformRuns } from "@infrawrench/server-core/db/schema";
import { db } from "../../db/client";
import type { GitPushEvent } from "../../env";
import { announcePullRequest, announcePush } from "../../events/ci";
import { handlePush } from "../../events/consumer";
import { type Person, type World, configured, makeWorld } from "./world";

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
      await world.call("POST", `${repo}/pulls`, {
        as: bob,
        body: { title: "Feature", base: "main", head: "feature" },
      })
    ).body;
    await world.call("POST", `${repo}/protected-branches`, {
      as: alice,
      body: { pattern: "main", requiredApprovals: 1, dismissStaleApprovals: true },
    });
    await world.call("POST", `${repo}/pulls/${pull.number}/reviews`, {
      as: alice,
      body: { event: "approve" },
    });
    expect((await world.call("GET", `${repo}/pulls/${pull.number}`)).body.reviewDecision).toBe(
      "approved",
    );
    vi.mocked(announcePullRequest).mockClear();

    const moved = await push("feature", { messages: ["One", "Two"], by: bob });
    const synced = (await world.call("GET", `${repo}/pulls/${pull.number}`)).body;
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

    await push("feature", { delete: true });
    const gone = (await world.call("GET", `${repo}/pulls/${pull.number}`, { as: bob })).body;
    expect(gone.headRefExists).toBe(false);
    expect(gone.mergeability.blockers.map((b: { code: string }) => b.code)).toContain(
      "head_missing",
    );
    expect(
      (await timeline(pull.number)).filter((entry) => entry.type === "head_branch_deleted"),
    ).toHaveLength(1);
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
      planOnPullRequest: true,
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
    await world.call("POST", `${repo}/pulls`, {
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
