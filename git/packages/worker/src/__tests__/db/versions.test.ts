/**
 * Versions of a branch against a real Postgres: the queue consumer copying
 * them from the storage (every push delivered twice), the branch page it
 * opens, review comments carried from version to version, the diffs and
 * marks the API serves over them, and pruning.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  gitBranchVersions,
  gitMergeOverrides,
  gitReviewFindings,
} from "@infrawrench/server-core/db/schema";
import { db, newId } from "../../db/client";
import { VERSION_RETENTION_MS } from "../../db/review";
import type { GitPushEvent } from "../../env";
import { handlePush } from "../../events/consumer";
import { pruneVersions } from "../../review/prune";
import { type Person, type World, configured, makeWorld, pagePath } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ZERO = "0".repeat(40);

describe.skipIf(!configured)("versions of a branch, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person;
  let repo: string;
  let id: string;
  let count = 0;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob] = (await Promise.all(["alice", "bob"].map((name) => world.person(name)))) as [
      Person,
      Person,
    ];
  });
  afterAll(() => world?.cleanup());
  // A repository a test: what one opens and prunes is nothing to the next.
  beforeEach(async () => {
    const made = await world.repository(alice, alice.username, `versions-${++count}`);
    repo = made.path;
    id = made.id;
    await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });
    world.storage.changedLines.clear();
    world.storage.lineShift = 0;
  });

  /** Move a branch in the storage, as a push does, and deliver its event twice (or not at all). */
  const push = async (
    branch: string,
    options: {
      forced?: boolean;
      delete?: boolean;
      by?: Person;
      message?: string;
      deliver?: boolean;
      at?: number;
    } = {},
  ) => {
    const at = options.at ?? Date.now();
    const newOid = options.delete ? ZERO : world.storage.nextOid();
    if (!options.delete) {
      world.storage.commits.set(newOid, {
        message: options.message ?? "A change",
        email: (options.by ?? alice).email,
      });
    }
    const oldOid =
      world.storage.moveBranch(id, branch, options.delete ? null : newOid, {
        forced: options.forced ?? false,
        at,
      }) ?? ZERO;
    const event: GitPushEvent = {
      type: "push",
      repoId: id,
      actor: { kind: "user", userId: (options.by ?? alice).id, credentialId: null },
      updates: [{ name: `refs/heads/${branch}`, oldOid, newOid, forced: options.forced ?? false }],
      at,
    };
    if (options.deliver !== false) {
      await handlePush(event, world.env, world.storage.readers);
      await handlePush(event, world.env, world.storage.readers);
    }
    return { oldOid, newOid };
  };
  const rows = (branch: string) =>
    db
      .select()
      .from(gitBranchVersions)
      .where(and(eq(gitBranchVersions.repositoryId, id), eq(gitBranchVersions.branch, branch)))
      .orderBy(gitBranchVersions.lineage, gitBranchVersions.number);
  const pullsOf = async (branch: string) =>
    (await world.call("GET", `${repo}/branch-pages?state=all&head=${branch}`, { as: alice })).body
      .items as Array<Record<string, any>>;
  const versionsOf = async (key: string, as: Person = alice) =>
    (await world.call("GET", `${pagePath(repo, key)}/versions`, { as })).body;

  it("copies each push once and opens the branch's page at the first", async () => {
    const main = world.storage.repository(id).branches.get("main")!;
    const one = await push("feature", { message: "Add rate limits\n\nWith a body." });
    const [page] = await pullsOf("feature");
    expect(page).toMatchObject({
      key: "feature",
      title: "Add rate limits",
      draft: true,
      state: "open",
      baseRef: "main",
      headRef: "feature",
      headOid: one.newOid,
      latestVersion: 1,
    });
    expect(page!["author"].username).toBe(alice.username);

    const two = await push("feature", { forced: true, by: bob });
    // A push to the default branch is no version.
    await push("main");
    expect(await pullsOf("feature")).toHaveLength(1);
    expect(await rows("main")).toEqual([]);
    expect(await rows("feature")).toHaveLength(2);

    const listed = await versionsOf(page!["key"]);
    expect(listed).toMatchObject({ branch: "feature", latest: 2, viewerReviewed: null });
    expect(listed.versions).toMatchObject([
      {
        number: 1,
        lineage: 1,
        tipOid: one.newOid,
        baseOid: main,
        previousOid: null,
        forced: false,
        rebased: false,
        pusherKind: "user",
        agent: null,
        stats: { filesChanged: 1, additions: 3, deletions: 1 },
        counts: { comments: 0, findings: 0, traceEntries: 0, answeredInstructions: 0 },
        hasTrace: false,
        reviewStatus: null,
      },
      { number: 2, tipOid: two.newOid, previousOid: one.newOid, forced: true },
    ]);
    expect(listed.versions.map((version: any) => version.pusher.username)).toEqual([
      alice.username,
      bob.username,
    ]);
    expect(
      (await world.call("GET", `${pagePath(repo, page!["key"])}/versions/latest`)).body,
    ).toMatchObject({ number: 2 });
    expect((await world.call("GET", `${pagePath(repo, page!["key"])}/versions/9`)).status).toBe(
      404,
    );
  });

  it("catches up on pushes whose event never arrived", async () => {
    const lost = await push("feature", { deliver: false });
    await push("feature", { deliver: false, forced: true });
    const seen = await push("feature", { by: bob });
    const copied = await rows("feature");
    expect(copied.map((row) => [row.number, row.forced])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect(copied[0]).toMatchObject({ tipOid: lost.newOid, pusherUserId: null });
    expect(copied[2]).toMatchObject({ tipOid: seen.newOid, pusherUserId: bob.id });
    // All three are the page's, which was opened at the push that was heard.
    const [page] = await pullsOf("feature");
    expect((await versionsOf(page!["key"])).versions).toHaveLength(3);
  });

  it("opens no page a second time, and opens one when a branch without a page is read", async () => {
    expect((await world.call("GET", `${repo}/review-settings`, { as: bob })).status).toBe(403);
    expect((await world.call("GET", `${repo}/review-settings`, { as: alice })).body).toEqual({
      reviewAgentsEnabled: false,
      reviewerKinds: ["general"],
      mustFixBlocksMerge: true,
      availableReviewerKinds: ["general", "security", "tests", "terraform", "intent"],
    });
    const changed = await world.call("PATCH", `${repo}/review-settings`, {
      as: alice,
      body: { reviewerKinds: ["general", "security", "general"] },
    });
    expect(changed.body).toMatchObject({ reviewerKinds: ["general", "security"] });
    expect(changed.body).not.toHaveProperty("autoOpenBranchPages");

    // Closed by hand: the next push does not open another.
    await push("closed");
    const [first] = await pullsOf("closed");
    await world.call("POST", `${pagePath(repo, first!["key"])}/close`, { as: alice });
    await push("closed");
    expect(await pullsOf("closed")).toHaveLength(1);
    expect(await rows("closed")).toHaveLength(2);

    // Pushed while no event arrived (as before every branch had a page): it has none.
    await push("quiet", { deliver: false });
    await push("quiet", { deliver: false });
    expect(await pullsOf("quiet")).toEqual([]);
    // Nothing of its own: reading it opens nothing.
    world.storage
      .repository(id)
      .branches.set("level", world.storage.repository(id).branches.get("main")!);
    expect((await world.call("GET", pagePath(repo, "level"), { as: bob })).status).toBe(404);
    expect((await world.call("GET", pagePath(repo, "nowhere"), { as: bob })).status).toBe(404);
    expect((await world.call("GET", pagePath(repo, "main"), { as: bob })).status).toBe(404);
    expect(await pullsOf("level")).toEqual([]);
    // Reading a branch with commits of its own opens its page, as a draft by the reader.
    const read = await world.call("GET", pagePath(repo, "quiet"), { as: bob });
    expect(read).toMatchObject({
      status: 200,
      body: { key: "quiet", draft: true, state: "open", baseRef: "main", headRef: "quiet" },
    });
    expect(read.body.author.username).toBe(bob.username);
    expect(await pullsOf("quiet")).toHaveLength(1);
    // Read again, it is the same page; proposing it now is a 409.
    expect((await world.call("GET", pagePath(repo, "quiet"), { as: alice })).body.number).toBe(
      read.body.number,
    );
    expect(
      await world.call("POST", `${repo}/branch-pages`, { as: bob, body: { head: "quiet" } }),
    ).toMatchObject({ status: 409, body: { code: "branch_page_exists" } });
    // A branch that had a page and has none open is not opened again by reading it.
    await world.call("POST", `${pagePath(repo, "quiet")}/close`, { as: alice });
    expect((await world.call("GET", pagePath(repo, "quiet"), { as: bob })).body.state).toBe(
      "closed",
    );
    expect(await pullsOf("quiet")).toHaveLength(1);

    // Versions are recorded whether or not an event was heard, and a page opened later gets them.
    await push("by-hand", { deliver: false });
    await push("by-hand", { deliver: false });
    expect(await rows("by-hand")).toHaveLength(0);
    await push("by-hand");
    expect(await rows("by-hand")).toHaveLength(3);
    const [byHand] = await pullsOf("by-hand");
    expect(byHand).toMatchObject({ draft: true, latestVersion: 3 });
    expect((await versionsOf(byHand!["key"])).versions.map((v: any) => v.number)).toEqual([
      1, 2, 3,
    ]);
  });

  it("carries a comment to the next version, or says which version answered it", async () => {
    await push("feature");
    const [page] = await pullsOf("feature");
    const pull = `${pagePath(repo, page!["key"])}`;
    const comment = async (line: number, startLine?: number) =>
      (
        await world.call("POST", `${pull}/comments`, {
          as: bob,
          body: { body: `About line ${line}`, path: "src/a.ts", line, side: "RIGHT", startLine },
        })
      ).body.thread as Record<string, any>;
    const stands = await comment(10, 8);
    const answered = await comment(20);
    expect(stands).toMatchObject({ version: 1, answeredInVersion: null, outdated: false });
    expect(stands["comments"][0]).toMatchObject({ version: 1 });

    world.storage.changedLines.add(answered["id"]);
    world.storage.lineShift = 2;
    const two = await push("feature");
    const threads = async () =>
      Object.fromEntries(
        (
          (await world.call("GET", `${pull}/threads`, { as: bob })).body.threads as Array<
            Record<string, any>
          >
        ).map((thread) => [thread["id"], thread]),
      );
    let after = await threads();
    // Its lines stand: it is on the new version, where they are now.
    expect(after[stands["id"]]).toMatchObject({
      line: 12,
      startLine: 10,
      outdated: false,
      commitOid: two.newOid,
      version: 1,
      answeredInVersion: null,
      originalLine: 10,
    });
    // Its lines changed: version 2 answered it, and it stays where it was written.
    expect(after[answered["id"]]).toMatchObject({
      line: null,
      outdated: true,
      version: 1,
      answeredInVersion: 2,
      originalLine: 20,
    });

    // A reply is written on the version current then, in the thread's place.
    const reply = await world.call("POST", `${pull}/comments`, {
      as: alice,
      body: { body: "Fixed", inReplyTo: answered["id"] },
    });
    expect(reply.body.comment).toMatchObject({ version: 2 });

    world.storage.changedLines.clear();
    world.storage.lineShift = 0;
    const three = await push("feature");
    after = await threads();
    expect(after[stands["id"]]).toMatchObject({ line: 12, commitOid: three.newOid, version: 1 });
    expect(after[answered["id"]]).toMatchObject({ outdated: true, answeredInVersion: 2 });
    expect((await versionsOf(page!["key"])).versions.map((v: any) => v.counts.comments)).toEqual([
      2, 1, 0,
    ]);
  });

  it("serves the diffs between versions, and remembers how far each person has reviewed", async () => {
    const one = await push("feature");
    const two = await push("feature");
    const [page] = await pullsOf("feature");
    const pull = `${pagePath(repo, page!["key"])}`;
    const diff = async (version: string, from?: string, as: Person = bob) =>
      world.call(
        "GET",
        `${pull}/versions/${version}/diff${from === undefined ? "" : `?from=${from}`}`,
        { as },
      );

    expect((await diff("latest")).body).toMatchObject({
      kind: "whole",
      from: null,
      to: 2,
      headOid: two.newOid,
      rebased: false,
      exact: true,
    });
    expect((await diff("2", "previous")).body).toMatchObject({
      kind: "interdiff",
      from: 1,
      to: 2,
      baseOid: one.newOid,
      headOid: two.newOid,
    });
    // The first version has none before it: its step is the whole of it.
    expect((await diff("1", "previous")).body).toMatchObject({ kind: "whole", from: null, to: 1 });
    // Nothing reviewed yet: since they last looked is everything.
    expect((await diff("latest", "reviewed")).body).toMatchObject({ kind: "whole", to: 2 });
    expect((await diff("1", "2")).status).toBe(422);
    expect((await diff("2", "7")).status).toBe(422);
    expect((await diff("7")).status).toBe(404);

    // Bob has no part in it yet, so it is not in his inbox; alice pushed it herself.
    const inbox = async (as: Person) =>
      (await world.call("GET", "/api/review/inbox", { as })).body.items as Array<
        Record<string, any>
      >;
    const mine = (items: Array<Record<string, any>>) =>
      items.filter((item) => item["repository"].id === id);
    expect(mine(await inbox(bob))).toEqual([]);
    expect((await world.call("GET", "/api/review/inbox")).status).toBe(401);
    expect((await world.call("GET", `${pull}/branch-state`, { as: bob })).body).toMatchObject({
      state: "needs_your_review",
      latestVersion: 2,
      viewerReviewedVersion: null,
      unreviewedVersions: 2,
      agent: null,
      openInstructions: 0,
      findings: { found: 0, mustFixOpen: 0 },
      settings: { reviewAgentsEnabled: false, mustFixBlocksMerge: true },
    });
    expect((await world.call("GET", `${pull}/branch-state`, { as: alice })).body.state).toBe(
      "waiting",
    );

    const marked = await world.call("PUT", `${pull}/versions/1/reviewed`, { as: bob });
    expect(marked.body).toMatchObject({ version: 1 });
    expect((await world.call("PUT", `${pull}/versions/1/reviewed`)).status).toBe(401);
    expect((await versionsOf(page!["key"], bob)).viewerReviewed).toBe(1);
    expect((await diff("latest", "reviewed")).body).toMatchObject({
      kind: "interdiff",
      from: 1,
      to: 2,
    });
    expect(mine(await inbox(bob))).toMatchObject([
      {
        number: page!["number"],
        branch: "feature",
        draft: true,
        latestVersion: 2,
        reviewedVersion: 1,
        changes: { versions: 1, comments: 0, findings: 0 },
        mustFixOpen: 0,
        agent: null,
      },
    ]);
    expect((await world.call("GET", `${pull}/branch-state`, { as: bob })).body).toMatchObject({
      state: "needs_your_review",
      viewerReviewedVersion: 1,
      unreviewedVersions: 1,
    });

    await world.call("PUT", `${pull}/versions/latest/reviewed`, { as: bob });
    // A mark never moves back.
    expect(
      (await world.call("PUT", `${pull}/versions/1/reviewed`, { as: bob })).body,
    ).toMatchObject({ version: 2 });
    expect(mine(await inbox(bob))).toEqual([]);
    expect((await world.call("GET", `${pull}/branch-state`, { as: bob })).body).toMatchObject({
      state: "waiting",
      unreviewedVersions: 0,
    });
    // The next push puts it back, with what changed since.
    await push("feature");
    expect(mine(await inbox(bob))).toMatchObject([
      { latestVersion: 3, reviewedVersion: 2, changes: { versions: 1 } },
    ]);
  });

  it("holds a merge on an open must-fix finding until it is overridden", async () => {
    await push("feature");
    const [page] = await pullsOf("feature");
    const pull = `${pagePath(repo, page!["key"])}`;
    await world.call("PUT", `${pull}/draft`, { as: alice, body: { draft: false } });
    const blockers = async () =>
      (
        (await world.call("GET", pull, { as: alice })).body.mergeability.blockers as Array<{
          code: string;
        }>
      ).map((blocker) => blocker.code);
    expect(await blockers()).toEqual([]);

    const findingId = newId();
    const [version] = await rows("feature");
    await db.insert(gitReviewFindings).values({
      id: findingId,
      repositoryId: id,
      pullRequestId: page!["id"],
      versionId: version!.id,
      versionNumber: 1,
      lastSeenVersionNumber: 1,
      reviewerKind: "security",
      fingerprint: "security:src/a.ts:token-in-log",
      path: "src/a.ts",
      startLine: 4,
      endLine: 4,
      commitOid: version!.tipOid,
      severity: "must_fix",
      title: "A token is written to the log",
    });
    expect(await blockers()).toEqual(["must_fix_findings"]);
    const held = (await world.call("GET", pull, { as: alice })).body.mergeability;
    expect(held).toMatchObject({
      canMerge: false,
      findings: { mustFixOpen: 1, blocks: true, canOverride: true },
    });
    expect(
      await world.call("POST", `${pull}/merge`, { as: alice, body: { method: "merge" } }),
    ).toMatchObject({ status: 422, body: { code: "must_fix_findings" } });
    expect((await world.call("GET", `${pull}/branch-state`, { as: bob })).body).toMatchObject({
      state: "must_fix_open",
      findings: { found: 1, open: 1, mustFixOpen: 1, needsPerson: 1 },
    });

    await db.insert(gitMergeOverrides).values({
      id: newId(),
      repositoryId: id,
      pullRequestId: page!["id"],
      userId: alice.id,
      reason: "A false positive: the value is a placeholder",
      findingIds: [findingId],
      headOid: version!.tipOid,
    });
    expect(await blockers()).toEqual([]);
    await db.delete(gitMergeOverrides).where(eq(gitMergeOverrides.pullRequestId, page!["id"]));
    expect(await blockers()).toEqual(["must_fix_findings"]);
    // A repository that does not hold merges on findings lists it and lets the merge through.
    await world.call("PATCH", `${repo}/review-settings`, {
      as: alice,
      body: { mustFixBlocksMerge: false },
    });
    expect(await blockers()).toEqual([]);
    expect(
      (await world.call("POST", `${pull}/merge`, { as: alice, body: { method: "merge" } })).status,
    ).toBe(200);
    // Merged: its versions are due thirty days on.
    const [kept] = await rows("feature");
    expect(kept!.pruneAfter!.getTime()).toBeGreaterThan(Date.now() + VERSION_RETENTION_MS - 60_000);
  });

  it("prunes a branch's versions thirty days after it is deleted, and keeps a new lineage", async () => {
    const day = 24 * 60 * 60 * 1000;
    const start = Date.now() - 40 * day;
    await push("gone", { at: start });
    await push("gone", { at: start + 1000, forced: true });
    await push("gone", { delete: true, at: start + 2000 });
    const marked = await rows("gone");
    expect(marked.map((row) => row.pruneAfter?.getTime())).toEqual([
      start + 2000 + VERSION_RETENTION_MS,
      start + 2000 + VERSION_RETENTION_MS,
    ]);
    // Made again with other work: a new lineage, which is alive.
    await push("gone", { at: start + 3000 });
    expect((await rows("gone")).map((row) => [row.lineage, row.number, row.pruneAfter])).toEqual([
      [1, 1, expect.any(Date)],
      [1, 2, expect.any(Date)],
      [2, 1, null],
    ]);

    const options = { readers: world.storage.readers };
    // Not yet: twenty-nine days after the deletion.
    await pruneVersions(world.env, { ...options, now: new Date(start + 29 * day) });
    expect(await rows("gone")).toHaveLength(3);
    expect(world.storage.repository(id).pruned).toEqual([]);

    await pruneVersions(world.env, { ...options, now: new Date(start + 31 * day) });
    expect((await rows("gone")).map((row) => [row.lineage, row.number])).toEqual([[2, 1]]);
    expect(world.storage.repository(id).pruned).toEqual(["gone 1/1", "gone 1/2"]);
    // Nothing more is due, and the storage keeps the lineage that lives.
    await pruneVersions(world.env, { ...options, now: new Date(start + 31 * day) });
    expect(world.storage.repository(id).versions.map((v) => `${v.lineage}/${v.number}`)).toEqual([
      "2/1",
    ]);
  });

  it("starts work from an ask: a branch, its draft page and the agent behind it", async () => {
    const main = world.storage.repository(id).branches.get("main")!;
    const ask = "Add rate limits to the API\n\nPer token, with a 429 and `Retry-After`.";
    expect((await world.call("POST", `${repo}/work`, { body: { ask } })).status).toBe(401);
    const started = await world.call("POST", `${repo}/work`, {
      as: bob,
      body: { ask, agent: { kind: "mcp", displayName: "Claude Code" } },
    });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      branch: "work/add-rate-limits-to-the-api",
      page: {
        key: "work/add-rate-limits-to-the-api",
        title: "Add rate limits to the API",
        body: ask,
        draft: true,
        baseRef: "main",
        headRef: "work/add-rate-limits-to-the-api",
        headOid: main,
        commitCount: 0,
        latestVersion: null,
      },
      agent: { kind: "mcp", displayName: "Claude Code", externalRefs: {} },
    });
    expect(started.body.agent.connectedBy.username).toBe(bob.username);
    const { number, key } = started.body.page;
    const branch: string = started.body.branch;
    expect(world.storage.repository(id).branches.get(branch)).toBe(main);
    expect(world.storage.repository(id).pullRefs.get(number)).toBe(main);
    expect(await versionsOf(key)).toMatchObject({ versions: [], latest: null });

    // The same ask again takes the next free name; a name asked for and taken is a 409.
    const again = await world.call("POST", `${repo}/work`, { as: bob, body: { ask } });
    expect(again.body.branch).toBe("work/add-rate-limits-to-the-api-2");
    expect(
      await world.call("POST", `${repo}/work`, { as: bob, body: { ask, branch } }),
    ).toMatchObject({ status: 409, body: { code: "ref_exists" } });
    expect(
      await world.call("POST", `${repo}/work`, { as: bob, body: { ask, base: "nowhere" } }),
    ).toMatchObject({ status: 422, body: { code: "ref_not_found" } });

    // The agent's first push is version 1 of that page, and names the agent.
    await push(branch, { by: bob });
    expect(await pullsOf(branch)).toHaveLength(1);
    expect((await versionsOf(key)).versions).toMatchObject([
      {
        number: 1,
        previousOid: main,
        agent: { kind: "mcp", name: "Claude Code", sessionRef: null },
      },
    ]);
    // Pushed with bob's credential, but by the agent: it is his to review.
    expect(
      (await world.call("GET", `${pagePath(repo, key)}/branch-state`, { as: bob })).body,
    ).toMatchObject({ state: "needs_your_review", agent: { kind: "mcp" } });

    const agent = `${pagePath(repo, key)}/agent`;
    expect(
      (
        await world.call("PUT", agent, {
          as: alice,
          body: { kind: "t3", displayName: "T3 Code", t3EnvironmentId: "not-mine" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await world.call("PUT", agent, {
          as: alice,
          body: {
            kind: "infrawrench",
            displayName: "Infrawrench",
            externalRefs: { sessionId: "session-1" },
          },
        })
      ).body.agent,
    ).toMatchObject({ kind: "infrawrench", externalRefs: { sessionId: "session-1" } });
    expect((await world.call("DELETE", agent, { as: bob })).status).toBe(200);
    expect((await world.call("GET", agent)).body).toEqual({ agent: null });
  });

  it("has no review mode any more, and keeps its gates first", async () => {
    // One way to read a branch: the mode a person once chose is gone from the API.
    expect((await world.call("GET", "/api/review/mode", { as: bob })).status).toBe(404);

    await push("feature");
    const [page] = await pullsOf("feature");
    const pull = `${pagePath(repo, page!["key"])}`;
    // The gates come first: only an administrator overrides, and a token never reaches T3 Code.
    expect(
      (
        await world.call("POST", `${pull}/findings/override`, {
          as: bob,
          body: { reason: "Because" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await world.call("GET", "/api/t3/environments", { as: bob, scopes: ["repo:write"] })).status,
    ).toBe(403);
  });
});
