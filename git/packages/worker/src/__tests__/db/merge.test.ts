/**
 * Merging under a protected branch, against a real Postgres: required
 * status contexts read from `git_commit_statuses` (as the app's CI writes
 * them), required approvals, who may bypass, and what a merge records.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeGitCommitStatus } from "@infrawrench/server-core/ci/status";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const CI = "Infrawrench CI / pull request";

describe.skipIf(!configured)("merging, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, carol] = (await Promise.all(
      ["alice", "bob", "carol"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
  });
  afterAll(() => world?.cleanup());

  /** A repository of alice's, bob with `write`, and a pull request of bob's from `feature`. */
  const scene = async (name: string, rule?: Record<string, unknown>) => {
    const made = await world.repository(alice, alice.username, name);
    const repo = made.path;
    await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });
    await world.call("PUT", `${repo}/collaborators/${carol.username}`, {
      as: alice,
      body: { role: "write" },
    });
    const storage = world.storage.repository(made.id);
    const head = world.storage.nextOid();
    storage.branches.set("feature", head);
    if (rule) {
      const created = await world.call("POST", `${repo}/protected-branches`, {
        as: alice,
        body: { pattern: "main", ...rule },
      });
      expect(created.status).toBe(200);
    }
    const pull = (
      await world.call("POST", `${repo}/pulls`, {
        as: bob,
        body: { title: "Add the thing", base: "main", head: "feature" },
      })
    ).body;
    const path = `${repo}/pulls/${pull.number}`;
    return {
      id: made.id,
      repo,
      path,
      head,
      number: pull.number as number,
      storage,
      merge: (who: Person, body: Record<string, unknown> = {}) =>
        world.call("POST", `${path}/merge`, { as: who, body: { method: "merge", ...body } }),
      mergeability: async (who: Person) =>
        (await world.call("GET", `${path}/mergeability`, { as: who })).body,
      review: (who: Person, event: string, body = "") =>
        world.call("POST", `${path}/reviews`, { as: who, body: { event, body } }),
    };
  };
  const blockers = (mergeability: { blockers: Array<{ code: string }> }) =>
    mergeability.blockers.map((blocker) => blocker.code);

  it("holds a merge until the required status and the required approval are in", async () => {
    const s = await scene("guarded", {
      requiredApprovals: 1,
      requiredStatusContexts: [CI],
      enforceAdmins: true,
    });

    let state = await s.mergeability(alice);
    expect(state).toMatchObject({ state: "clean", canMerge: false, canBypass: false });
    expect(blockers(state)).toEqual(["checks_pending", "approvals_required"]);
    expect(state.checks.required).toEqual([{ context: CI, state: null }]);
    expect(state.reviews).toMatchObject({
      requiredApprovals: 1,
      approvals: 0,
      decision: "review_required",
    });
    expect(await s.merge(alice)).toMatchObject({ status: 422, body: { code: "checks_required" } });
    // Enforced on administrators: there is no bypass to ask for.
    expect((await s.merge(alice, { bypass: true })).status).toBe(403);

    // The app's CI reports through server-core's writer; a failure blocks as a failure.
    const status = (state: "pending" | "success" | "failure") =>
      writeGitCommitStatus({
        repositoryId: s.id,
        sha: s.head,
        context: CI,
        state,
        description: state,
        targetUrl: null,
      });
    await status("failure");
    expect(blockers(await s.mergeability(alice))).toEqual(["checks_failed", "approvals_required"]);
    await status("success");
    state = await s.mergeability(alice);
    expect(blockers(state)).toEqual(["approvals_required"]);
    // Reported three times, one row: the newest state of the context.
    expect(state.checks.statuses).toHaveLength(1);
    expect(state.checks).toMatchObject({
      state: "success",
      required: [{ context: CI, state: "success" }],
    });
    expect(await s.merge(alice)).toMatchObject({
      status: 422,
      body: { code: "approvals_required" },
    });

    // The author cannot approve their own; a comment is not an approval.
    expect((await s.review(bob, "approve")).status).toBe(422);
    expect((await s.review(carol, "comment", "Looks plausible")).status).toBe(200);
    expect(blockers(await s.mergeability(alice))).toEqual(["approvals_required"]);

    // A request for changes blocks until it is dismissed, even beside an approval.
    const changes = (await s.review(carol, "request_changes", "Tests?")).body;
    expect((await s.review(alice, "approve")).status).toBe(200);
    state = await s.mergeability(alice);
    expect(blockers(state)).toEqual(["changes_requested"]);
    expect(state.reviews).toMatchObject({
      approvals: 1,
      changesRequested: 1,
      decision: "changes_requested",
    });
    expect(await s.merge(alice)).toMatchObject({
      status: 422,
      body: { code: "changes_requested" },
    });
    const dismissed = await world.call("PUT", `${s.path}/reviews/${changes.id}/dismiss`, {
      as: alice,
      body: { reason: "Covered by the suite" },
    });
    expect(dismissed.body).toMatchObject({
      state: "dismissed",
      dismissalReason: "Covered by the suite",
    });

    state = await s.mergeability(alice);
    expect(state).toMatchObject({ canMerge: true, blockers: [] });
    expect(state.reviews.decision).toBe("approved");

    // The person looked at an older head.
    expect(await s.merge(alice, { expectedHeadOid: "f".repeat(40) })).toMatchObject({
      status: 409,
      body: { code: "head_moved" },
    });
    const merged = await s.merge(alice, { expectedHeadOid: s.head, method: "squash" });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ merged: true, method: "squash", branchDeleted: false });
    expect(s.storage.branches.get("main")).toBe(merged.body.commitOid);
    expect(world.storage.merges.at(-1)).toMatchObject({
      baseRef: "main",
      headOid: s.head,
      method: "squash",
      title: `Add the thing (#${s.number})`,
      committer: { email: alice.email },
    });

    const pull = (await world.call("GET", s.path, { as: alice })).body;
    expect(pull).toMatchObject({
      state: "merged",
      mergeCommitOid: merged.body.commitOid,
      mergeMethod: "squash",
    });
    expect(pull.mergedBy.username).toBe(alice.username);
    expect(blockers(pull.mergeability)).toEqual(["merged"]);
    expect(await s.merge(alice)).toMatchObject({ status: 422, body: { code: "already_merged" } });
    const timeline = (await world.call("GET", `${s.repo}/issues/${s.number}/timeline?limit=100`))
      .body.items;
    expect(timeline.map((item: { type: string }) => item.type)).toEqual([
      "review",
      "review",
      "review",
      "review_dismissed",
      "merged",
    ]);
    expect((await world.call("GET", s.repo)).body.openPullRequestCount).toBe(0);
    expect((await world.call("GET", `${s.repo}/pulls?state=merged`)).body.items).toHaveLength(1);
  });

  it("lets an administrator bypass a rule that does not bind administrators, and nobody else", async () => {
    const s = await scene("bypass", { requiredApprovals: 2, requiredStatusContexts: [CI] });
    const forAdmin = await s.mergeability(alice);
    expect(forAdmin).toMatchObject({ canMerge: false, canBypass: true });
    expect((await s.mergeability(carol)).canBypass).toBe(false);
    expect((await s.merge(carol, { bypass: true })).status).toBe(403);
    expect((await s.merge(alice)).status).toBe(422);
    expect((await s.merge(alice, { bypass: true })).status).toBe(200);
  });

  it("merges only with write access, only when ready, and only by an allowed method", async () => {
    const s = await scene("plain");
    const dave = await world.person("dave");
    expect((await s.merge(dave)).status).toBe(403);
    expect(
      (await world.call("POST", `${s.path}/merge`, { body: { method: "merge" } })).status,
    ).toBe(401);

    await world.call("PUT", `${s.path}/draft`, { as: bob, body: { draft: true } });
    expect(await s.merge(alice)).toMatchObject({ status: 422, body: { code: "draft" } });
    await world.call("PUT", `${s.path}/draft`, { as: bob, body: { draft: false } });

    await world.call("PATCH", s.repo, { as: alice, body: { merge: { allowRebase: false } } });
    expect(await s.merge(alice, { method: "rebase" })).toMatchObject({
      status: 422,
      body: { code: "merge_method_not_allowed" },
    });
    expect((await s.mergeability(alice)).allowedMethods).toEqual(["merge", "squash"]);

    world.storage.conflicting.add(s.head);
    const state = await s.mergeability(alice);
    expect(state).toMatchObject({ state: "conflicting", conflictFiles: ["README.md"] });
    expect(await s.merge(alice)).toMatchObject({ status: 422, body: { code: "merge_conflict" } });
    world.storage.conflicting.delete(s.head);

    // Deleting the head branch afterwards is the merger's choice.
    const merged = await s.merge(carol, { deleteBranch: true });
    expect(merged.body).toMatchObject({ merged: true, branchDeleted: true });
    expect(s.storage.branches.has("feature")).toBe(false);
    const pull = (await world.call("GET", s.path, { as: bob })).body;
    expect(pull).toMatchObject({ headRefExists: false });
    const restored = await world.call("POST", `${s.path}/restore-branch`, { as: bob });
    expect(restored.body).toEqual({ ref: "feature", oid: s.head });
  });

  it("keeps a restricted branch to its pushers", async () => {
    const s = await scene("restricted", {
      restrictPushers: true,
      pushers: [carol.username],
      enforceAdmins: true,
    });
    expect(blockers(await s.mergeability(alice))).toEqual(["push_restricted"]);
    expect(await s.merge(alice)).toMatchObject({ status: 422, body: { code: "protected_branch" } });
    expect((await s.mergeability(carol)).canMerge).toBe(true);
    // The same rule keeps anyone else from creating or deleting what it names.
    const rules = (await world.call("GET", `${s.repo}/protected-branches`, { as: alice })).body
      .rules;
    expect(rules[0]).toMatchObject({ pattern: "main", matchingBranches: ["main"] });
    expect(rules[0].pushers.map((user: { username: string }) => user.username)).toEqual([
      carol.username,
    ]);
    expect((await world.call("GET", `${s.repo}/protected-branches`, { as: bob })).status).toBe(403);
    expect((await s.merge(carol)).status).toBe(200);
  });

  it("anchors review comments to the diff and shows a pending review only to its author", async () => {
    const s = await scene("review");
    const comment = (body: Record<string, unknown>, who = carol) =>
      world.call("POST", `${s.path}/comments`, { as: who, body });
    // The fake's diff shows lines up to 100.
    expect(
      (await comment({ body: "Out there", path: "a.tf", line: 500, side: "RIGHT" })).status,
    ).toBe(422);
    expect((await comment({ body: "No anchor" })).status).toBe(400);
    const placed = await comment({
      body: "Why?",
      path: "a.tf",
      line: 3,
      side: "RIGHT",
      pending: true,
    });
    expect(placed.status).toBe(200);
    expect(placed.body.comment).toMatchObject({ pending: true });

    const threads = async (who: Person) =>
      (await world.call("GET", `${s.path}/threads`, { as: who })).body.threads;
    expect(await threads(carol)).toHaveLength(1);
    expect(await threads(bob)).toHaveLength(0);
    expect(
      (
        await world.call("PATCH", `${s.repo}/pulls/comments/${placed.body.comment.id}`, {
          as: alice,
          body: { body: "Peek" },
        })
      ).status,
    ).toBe(404);

    const pending = (await world.call("GET", s.path, { as: carol })).body.viewer.pendingReviewId;
    expect(pending).toBe(placed.body.comment.reviewId);
    const submitted = await world.call("POST", `${s.path}/reviews/${pending}/submit`, {
      as: carol,
      body: { event: "comment", body: "A question" },
    });
    expect(submitted.body).toMatchObject({ state: "commented", commentCount: 1 });
    expect(await threads(bob)).toHaveLength(1);

    const reply = await comment({ body: "Because.", inReplyTo: placed.body.comment.id }, bob);
    expect(reply.body.thread.comments).toHaveLength(2);
    const threadId = placed.body.thread.id;
    const dave = await world.person("erin");
    expect(
      (await world.call("PUT", `${s.repo}/pulls/threads/${threadId}/resolve`, { as: dave })).status,
    ).toBe(403);
    const resolved = await world.call("PUT", `${s.repo}/pulls/threads/${threadId}/resolve`, {
      as: bob,
    });
    expect(resolved.body).toMatchObject({ resolved: true });
    expect(resolved.body.resolvedBy.username).toBe(bob.username);
  });
});
