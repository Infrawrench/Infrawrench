/**
 * The mock's issues, branch pages, CI and Terraform answer what the pages
 * are built against: the fixtures hang together (a branch page's checks are
 * its runs, its plan is its workspace's run) and the writes do what the API
 * says they do.
 */
import { describe, expect, it } from "vitest";
import { FORGE_LIMITS, privateRepositoryRefusal } from "@infrawrench/git-contract";
import { ApiError } from "../../api/client";
import { parseSse, reduceFrames } from "../../features/ci/live";
import { deriveMergeBox } from "../../features/branch-page/merge-box";
import { indexThreads } from "../../features/branch-page/review-threads";
import branchHandlers from "../handlers/branches";
import ci from "../handlers/ci";
import contents from "../handlers/contents";
import infrastructure from "../handlers/infrastructure";
import issues from "../handlers/issues";
import labels from "../handlers/labels";
import milestones from "../handlers/milestones";
import repositories from "../handlers/repositories";
import repoSettings from "../handlers/repo-settings";
import review from "../handlers/review";
import sessionHandlers from "../handlers/session";
import settings from "../handlers/settings";
import { findRepository } from "../db";
import { findPage, pageKeyOf } from "../threads-data";

const repo = { owner: "acme", repo: "infra" };
const I = issues.issues!;
const P = branchHandlers.branches!;
const C = ci.ci!;
const T = infrastructure.terraform!;
const R = repositories.repositoryLists!;
const N = repositories.repositories!;

async function failure(run: () => unknown): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("Expected the call to fail");
}

describe("issues", () => {
  it("lists open issues with counts that match the repository's tab", async () => {
    const page = await I.list!({ params: repo, query: {} });
    expect(page.counts).toEqual({ open: 6, closed: 7 });
    expect(page.items.every((issue) => issue.state === "open")).toBe(true);
    expect(page.items.map((issue) => issue.number)).toEqual([15, 13, 6, 11, 8, 2]);
  });

  it("filters by label, assignee, milestone and words", async () => {
    const numbers = async (query: Parameters<NonNullable<typeof I.list>>[0]["query"]) =>
      (await I.list!({ params: repo, query: { state: "all", ...query } })).items.map(
        (issue) => issue.number,
      );
    expect(await numbers({ label: "cost" })).toEqual([2, 10]);
    expect(await numbers({ label: "cost,enhancement" })).toEqual([10]);
    expect(await numbers({ assignee: "none", state: "open" })).toEqual([15, 11]);
    expect(await numbers({ assignee: "@me" })).toEqual([8, 10]);
    expect(await numbers({ milestone: "1" })).toEqual([2, 10]);
    expect(await numbers({ q: "nat gateway" })).toEqual([2]);
    expect(await numbers({ sort: "comments", state: "open" })).toEqual([2, 13, 15, 8, 6, 11]);
  });

  it("answers 404 for a branch page's number, and locates no page for an issue's", async () => {
    expect((await failure(() => I.get!({ params: { ...repo, number: 12 } }))).status).toBe(404);
    expect(await P.locate!({ params: { ...repo, number: 12 } })).toEqual({
      key: "feature/vpc-peering",
    });
    expect((await failure(() => P.locate!({ params: { ...repo, number: 13 } }))).status).toBe(404);
    expect((await failure(() => P.locate!({ params: { ...repo, number: 99 } }))).status).toBe(404);
  });

  it("serves a timeline in order, events between comments", async () => {
    const { items } = await I.timeline!({ params: { ...repo, number: 13 }, query: {} });
    expect(items.map((item) => item.type)).toEqual([
      "labeled",
      "assigned",
      "comment",
      "comment",
      "unassigned",
      "assigned",
    ]);
  });

  it("records each change to a thread as an event", async () => {
    const created = await I.create!({
      params: repo,
      payload: { title: "A new one", labels: ["bug"], assignees: ["jonas"], milestone: 1 },
    });
    expect(created.number).toBe(19);
    expect(created.labels.map((label) => label.name)).toEqual(["bug"]);
    const params = { ...repo, number: created.number };
    await I.update!({ params, payload: { title: "Renamed", labels: ["cost"], milestone: null } });
    await I.update!({ params, payload: { state: "closed", stateReason: "not_planned" } });
    const closed = await I.get!({ params });
    expect(closed).toMatchObject({ state: "closed", stateReason: "not_planned", title: "Renamed" });
    const { items } = await I.timeline!({ params, query: {} });
    expect(items.map((item) => item.type)).toEqual([
      "labeled",
      "assigned",
      "milestoned",
      "renamed",
      "unlabeled",
      "labeled",
      "demilestoned",
      "closed",
    ]);
    expect((await I.list!({ params: repo, query: {} })).counts).toEqual({ open: 6, closed: 8 });
  });

  it("locks a thread and says so in its timeline", async () => {
    const params = { ...repo, number: 11 };
    await I.lock!({ params, payload: { reason: "resolved" } });
    expect(await I.get!({ params })).toMatchObject({ locked: true, lockReason: "resolved" });
    await I.unlock!({ params });
    const { items } = await I.timeline!({ params, query: {} });
    expect(items.slice(-2).map((item) => item.type)).toEqual(["locked", "unlocked"]);
  });
});

describe("labels and milestones", () => {
  it("refuses a second label of the same name, and removes a deleted one from threads", async () => {
    const L = labels.labels!;
    const error = await failure(() =>
      L.create!({ params: repo, payload: { name: "BUG", color: "ff0000" } }),
    );
    expect(error.status).toBe(409);
    const all = (await L.list!({ params: repo })).labels;
    const question = all.find((label) => label.name === "question")!;
    await L.delete!({ params: { ...repo, labelId: question.id } });
    expect((await I.get!({ params: { ...repo, number: 16 } })).labels).toEqual([]);
  });

  it("counts a milestone's open and closed threads", async () => {
    const M = milestones.milestones!;
    const cost = await M.get!({ params: { ...repo, milestone: 1 } });
    // #2 (open issue), #12 (open branch page), #10 (closed issue).
    expect(cost).toMatchObject({ title: "Cost review Q4", openCount: 2, closedCount: 1 });
    expect((await M.list!({ params: repo, query: {} })).milestones.map((m) => m.number)).toEqual([
      1, 2,
    ]);
  });
});

describe("branch pages", () => {
  it("lists them with the head's status and the review decision", async () => {
    const page = await P.list!({ params: repo, query: {} });
    expect(
      page.items.map((page) => [page.number, page.status, page.reviewDecision, page.draft]),
    ).toEqual([
      [18, null, "review_required", false],
      [14, "failure", "review_required", false],
      [12, "success", "approved", false],
    ]);
    expect(page.items.map((item) => item.key)).toEqual([
      "feature/budgets/staging-alarm",
      "fix/database-backups",
      "feature/vpc-peering",
    ]);
    expect(page.counts).toEqual({ open: 3, closed: 2 });
    const merged = await P.list!({ params: repo, query: { state: "merged" } });
    expect(merged.items.map((page) => [page.number, page.state])).toEqual([[7, "merged"]]);
  });

  it("computes a page from its branches", async () => {
    const page = await P.get!({ params: { ...repo, branch: "feature/vpc-peering" } });
    expect(page).toMatchObject({
      baseRef: "main",
      headRef: "feature/vpc-peering",
      commitCount: 3,
      headRefExists: true,
    });
    expect(page.stats.filesChanged).toBe(5);
    const commits = await P.commits!({
      params: { ...repo, branch: "feature/vpc-peering" },
      query: {},
    });
    expect(commits.items.map((commit) => commit.summary)).toEqual([
      "network: peer with the shared services VPC",
      "staging: peer with shared services",
      "docs: how the peering routes are laid out",
    ]);
    const files = await P.files!({ params: { ...repo, branch: "feature/vpc-peering" }, query: {} });
    expect(files.files.map((file) => file.path)).toContain("docs/peering.md");
    expect(files.baseOid).toBe(page.mergeBaseOid);
  });

  it("keeps a merged page's commits and diff as they were", async () => {
    const page = await P.get!({ params: { ...repo, branch: "feature/flow-logs" } });
    expect(page).toMatchObject({ state: "merged", commitCount: 2, mergeMethod: "merge" });
    expect(deriveMergeBox(page.mergeability, page.baseRef).action).toEqual({ mode: "none" });
  });

  it("anchors review threads on lines of the diff, with the lines they were written on", async () => {
    const params = { ...repo, branch: "feature/vpc-peering" };
    const { threads } = await P.listThreads!({ params });
    expect(threads.map((thread) => [thread.path, thread.line, thread.outdated])).toEqual([
      ["docs/peering.md", 3, false],
      ["environments/staging/main.tf", 31, false],
      ["modules/network/main.tf", 123, false],
      ["modules/network/variables.tf", null, true],
    ]);
    for (const thread of threads) {
      expect(thread.hunk, thread.path).not.toBeNull();
      const last = thread.hunk!.lines[thread.hunk!.lines.length - 1]!;
      expect(last.newLine).toBe(thread.originalLine);
    }
    const ranged = threads[2]!;
    expect(ranged).toMatchObject({ startLine: 121, resolved: true });
    expect(ranged.hunk!.lines[0]!.newLine).toBeLessThanOrEqual(121);
    // Every thread still on the diff lands on a line the diff shows.
    const { files } = await P.files!({ params, query: {} });
    const index = indexThreads(threads);
    const shown = new Set(
      files.flatMap((file) =>
        file.hunks.flatMap((hunk) =>
          hunk.lines.map((line) => `RIGHT:${line.newLine}:${file.path}`),
        ),
      ),
    );
    expect([...index.keys()].every((key) => shown.has(key))).toBe(true);
  });

  it("shows the viewer their own pending review and nobody else's", async () => {
    const params = { ...repo, branch: "feature/vpc-peering" };
    const page = await P.get!({ params });
    expect(page.viewer.pendingReviewId).not.toBeNull();
    const { reviews } = await P.listReviews!({ params });
    expect(reviews.map((review) => [review.author?.username, review.state, review.stale])).toEqual([
      ["priya", "changes_requested", true],
      ["priya", "approved", false],
      ["mara", "pending", false],
    ]);
    const { items } = await I.timeline!({ params: { ...repo, number: 12 }, query: {} });
    const inTimeline = items.flatMap((item) => (item.type === "review" ? [item.review.state] : []));
    expect(inTimeline).toEqual(["changes_requested", "approved"]);
  });

  it("is mergeable when approved and green, and names what blocks the other", async () => {
    // A review agent's must-fix finding holds it until an administrator merges past it.
    const held = (await P.get!({ params: { ...repo, branch: "feature/vpc-peering" } }))
      .mergeability;
    expect(held.blockers.map((blocker) => blocker.code)).toEqual(["must_fix_findings"]);
    expect(held.findings).toEqual({ mustFixOpen: 1, blocks: true, canOverride: true });
    expect(deriveMergeBox(held, "main").action.mode).toBe("blocked");
    await review.findings!.override!({
      params: { ...repo, branch: "feature/vpc-peering" },
      payload: { reason: "The shared services account accepts on its side" },
    });
    const ready = (await P.get!({ params: { ...repo, branch: "feature/vpc-peering" } }))
      .mergeability;
    expect(ready).toMatchObject({ state: "clean", behindBy: 3, canMerge: true, blockers: [] });
    expect(ready.checks.required).toEqual([
      { context: "Infrawrench CI / fmt", state: "success" },
      { context: "Infrawrench CI / validate", state: "success" },
    ]);
    expect(ready.canUpdateBranch).toBe(true);

    const stuck = (await P.get!({ params: { ...repo, branch: "fix/database-backups" } }))
      .mergeability;
    expect(stuck.blockers.map((blocker) => blocker.code)).toEqual([
      "checks_failed",
      "approvals_required",
    ]);
    expect(deriveMergeBox(stuck, "main").action.mode).toBe("bypass");
    const refused = await failure(() =>
      P.merge!({
        params: { ...repo, branch: "fix/database-backups" },
        payload: { method: "merge" },
      }),
    );
    expect([refused.status, refused.code]).toEqual([422, "checks_required"]);
  });

  it("submits a pending review, threads a reply, and resolves", async () => {
    const params = { ...repo, branch: "fix/database-backups" };
    const started = await P.createReviewComment!({
      params,
      payload: {
        body: "Why 14?",
        path: "modules/database/variables.tf",
        line: 41,
        side: "RIGHT",
        startLine: 39,
        pending: true,
      },
    });
    expect(started.comment.pending).toBe(true);
    expect(started.thread).toMatchObject({ line: 41, startLine: 39 });
    const reviewId = (await P.get!({ params })).viewer.pendingReviewId!;
    expect(reviewId).toBe(started.comment.reviewId);

    const offDiff = await failure(() =>
      P.createReviewComment!({
        params,
        payload: { body: "x", path: "modules/database/variables.tf", line: 1, side: "RIGHT" },
      }),
    );
    expect(offDiff.status).toBe(422);

    const review = await P.submitReview!({
      params: { ...params, reviewId },
      payload: { event: "approve", body: "Fine by me" },
    });
    expect(review).toMatchObject({ state: "approved", commentCount: 1 });
    expect((await P.get!({ params })).viewer.pendingReviewId).toBeNull();

    const reply = await P.createReviewComment!({
      params,
      payload: { body: "Two weeks.", inReplyTo: started.comment.id },
    });
    expect(reply.thread.id).toBe(started.thread.id);
    expect(reply.thread.comments.map((comment) => comment.pending)).toEqual([false, false]);
    const resolved = await P.resolveThread!({ params: { ...repo, threadId: started.thread.id } });
    expect(resolved).toMatchObject({ resolved: true });

    // Approved now, but the required check still fails.
    const { mergeability } = await P.get!({ params });
    expect(mergeability.reviews).toMatchObject({ decision: "approved", approvals: 1 });
    expect(mergeability.blockers.map((blocker) => blocker.code)).toEqual(["checks_failed"]);
  });

  it("does not let an author approve their own branch", async () => {
    const error = await failure(() =>
      P.createReview!({
        params: { owner: "acme", repo: "edge-router", branch: "feature/health-checks" },
        payload: { event: "approve" },
      }),
    );
    expect(error.status).toBe(422);
  });

  it("updates a branch, waits for its checks, then merges and deletes it", async () => {
    const params = { ...repo, branch: "feature/vpc-peering" };
    const before = await P.get!({ params });
    const mainFiles = (await P.files!({ params, query: {} })).files.map((file) => file.path);

    const stale = await failure(() =>
      P.merge!({ params, payload: { method: "squash", expectedHeadOid: "0".repeat(40) } }),
    );
    expect([stale.status, stale.code]).toEqual([409, "head_moved"]);

    const { headOid } = await P.updateBranch!({ params, payload: {} });
    const updated = await P.get!({ params });
    expect(updated.headOid).toBe(headOid);
    expect(updated.mergeability.behindBy).toBe(0);
    // The diff is the same files: the merge brought the base in without undoing anything.
    expect((await P.files!({ params, query: {} })).files.map((file) => file.path)).toEqual(
      mainFiles,
    );
    // New commits: the approval was of the old head, and the checks run again.
    expect(updated.mergeability.blockers.map((blocker) => blocker.code)).toEqual([
      "checks_pending",
      "approvals_required",
    ]);
    expect(deriveMergeBox(updated.mergeability, "main").poll).toBe(true);
    const running = await C.listRuns!({ params: repo, query: { sha: headOid } });
    expect(running.items.map((run) => run.status)).toEqual(["running"]);

    const merged = await P.merge!({
      params,
      payload: { method: "squash", bypass: true, deleteBranch: true, expectedHeadOid: headOid },
    });
    expect(merged).toMatchObject({ merged: true, method: "squash", branchDeleted: true });
    const after = await P.get!({ params });
    expect(after).toMatchObject({
      state: "merged",
      headRefExists: false,
      mergeCommitOid: merged.commitOid,
      commitCount: before.commitCount + 1,
    });
    const { items } = await I.timeline!({ params: { ...repo, number: 12 }, query: {} });
    expect(items.slice(-2).map((item) => item.type)).toEqual(["merged", "head_branch_deleted"]);
    const restored = await P.restoreBranch!({ params });
    expect(restored).toEqual({ ref: "feature/vpc-peering", oid: headOid });
  });

  it("opens a page only for a branch with commits of its own, and only one at a time", async () => {
    const same = await failure(() =>
      P.propose!({ params: repo, payload: { head: "feature/flow-logs" } }),
    );
    expect(same.code).toBe("no_commits_between");
    const exists = await failure(() =>
      P.propose!({ params: repo, payload: { head: "fix/database-backups", base: "main" } }),
    );
    expect([exists.status, exists.code]).toEqual([409, "branch_page_exists"]);
  });

  it("names a page by its branch, its fork and which page of the name it is", async () => {
    const infra = findRepository("acme", "infra");
    const second = findPage(infra, "feature/budgets/staging-alarm");
    expect(second.number).toBe(18);
    expect(pageKeyOf(infra, second)).toBe("feature/budgets/staging-alarm");
    expect(findPage(infra, "feature/budgets/staging-alarm~2")).toBe(second);
    const first = findPage(infra, "feature/budgets/staging-alarm~1");
    expect(first.number).toBe(17);
    expect(pageKeyOf(infra, first)).toBe("feature/budgets/staging-alarm~1");
    expect(() => findPage(infra, "feature/budgets/staging-alarm~3")).toThrow();
    expect(() => findPage(infra, "feature/budgets")).toThrow();

    const edge = findRepository("acme", "edge-router");
    const forked = findPage(edge, "jonas/edge-router:fix/lowercase-hosts");
    expect(pageKeyOf(edge, forked)).toBe("jonas/edge-router:fix/lowercase-hosts");
    expect(() => findPage(edge, "fix/lowercase-hosts")).toThrow();
    const page = await P.get!({
      params: {
        owner: "acme",
        repo: "edge-router",
        branch: "jonas/edge-router:fix/lowercase-hosts",
      },
    });
    expect(page).toMatchObject({
      key: "jonas/edge-router:fix/lowercase-hosts",
      crossRepository: true,
      headRepository: { owner: "jonas", name: "edge-router" },
      commitCount: 1,
      body: "Closes #5.",
    });
    expect(page.stats.filesChanged).toBe(1);
    const closed = await P.get!({
      params: { ...repo, branch: "feature/budgets/staging-alarm~1" },
    });
    expect(closed).toMatchObject({ state: "closed", key: "feature/budgets/staging-alarm~1" });
  });

  it("opens the page of a branch pushed without one when it is asked for", async () => {
    const page = await P.get!({ params: { ...repo, branch: "release/2026.11" } });
    expect(page).toMatchObject({ key: "release/2026.11", state: "open", baseRef: "main" });
    expect(page.title).toBe("2026.11");
    expect((await failure(() => P.get!({ params: { ...repo, branch: "main" } }))).status).toBe(404);
    expect(
      (await failure(() => P.get!({ params: { ...repo, branch: "no/such-branch" } }))).status,
    ).toBe(404);
  });
});

describe("a fork's branch", () => {
  const base = { owner: "acme", repo: "edge-router" };
  const fork = "jonas/edge-router";
  const K = contents.contents!;

  it("compares the parent's branch with the fork's, and names the fork", async () => {
    const comparison = await K.compare!({
      params: base,
      query: { base: "main", head: "feature/health-checks", headRepository: fork },
    });
    expect(comparison.headRepository).toEqual({ owner: "jonas", name: "edge-router" });
    expect(comparison.ahead).toBeGreaterThan(0);
    expect(comparison.commits).toHaveLength(comparison.ahead);
    const diff = await K.compareDiff!({
      params: base,
      query: { base: "main", head: "feature/health-checks", headRepository: fork },
    });
    expect(diff.files.length).toBeGreaterThan(0);
  });

  it("refuses a head repository outside the fork network", async () => {
    const refused = await failure(() =>
      K.compare!({
        params: base,
        query: { base: "main", head: "main", headRepository: "acme/infra" },
      }),
    );
    expect(refused.status).toBe(422);
  });

  it("is proposed to the parent, and only once while its page is open", async () => {
    const page = await P.propose!({
      params: repo,
      payload: { head: "docs/peering-notes", headRepository: "mara/infra" },
    });
    expect(page).toMatchObject({
      key: "mara/infra:docs/peering-notes",
      crossRepository: true,
      headRepository: { owner: "mara", name: "infra" },
      headRef: "docs/peering-notes",
      baseRef: "main",
      title: "Peering notes",
      commitCount: 1,
    });
    const again = await P.get!({ params: { ...repo, branch: page.key } });
    expect(again.number).toBe(page.number);
    const twice = await failure(() =>
      P.propose!({
        params: repo,
        payload: { head: "docs/peering-notes", headRepository: "mara/infra", title: "Again" },
      }),
    );
    expect([twice.status, twice.code]).toEqual([409, "branch_page_exists"]);
    const comparison = await K.compare!({
      params: repo,
      query: { base: "main", head: "docs/peering-notes", headRepository: "mara/infra" },
    });
    expect(comparison.page?.key).toBe("mara/infra:docs/peering-notes");
  });

  it("forks into a namespace the caller picks, under the name they give", async () => {
    const made = await N.fork!({
      params: base,
      payload: { owner: "tidewater", name: "edge-router-fork" },
    });
    expect(made).toMatchObject({ name: "edge-router-fork", isFork: true });
    expect(made.owner.slug).toBe("tidewater");
    expect(made.parent).toMatchObject({ owner: "acme", name: "edge-router" });
    // A private repository stays in its owner's namespace.
    const elsewhere = await failure(() =>
      N.fork!({ params: repo, payload: { owner: "tidewater", name: "infra" } }),
    );
    expect(elsewhere.status).toBe(422);
  });
});

describe("CI", () => {
  it("lists runs newest first, one of them in progress", async () => {
    const { items } = await C.listRuns!({ params: repo, query: { limit: 100 } });
    expect(items.length).toBeGreaterThan(8);
    expect([...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))).toEqual(items);
    expect(items.filter((run) => run.status === "running" && run.headRef === "main")).toHaveLength(
      1,
    );
    expect(items.some((run) => run.status === "awaiting_approval" && run.fromFork)).toBe(true);
    const failed = await C.listRuns!({ params: repo, query: { status: "failed" } });
    expect(failed.items.every((run) => run.status === "failed")).toBe(true);
    expect(failed.items.every((run) => run.jobs?.some((job) => job.status === "failed"))).toBe(
      true,
    );
  });

  it("serves a finished run's output and a running one's log", async () => {
    const { items } = await C.listRuns!({ params: repo, query: { status: "failed", ref: "main" } });
    const detail = await C.getRun!({ params: { ...repo, runId: items[0]!.id } });
    const broken = detail.jobs!.find((job) => job.status === "failed")!;
    expect(broken.stderr).toContain("Unsupported argument");
    expect(broken.stderr).toContain("\u001b[31m");

    const running = (await C.listRuns!({ params: repo, query: { status: "running", ref: "main" } }))
      .items[0]!;
    expect((await C.getRun!({ params: { ...repo, runId: running.id } })).jobs).toBeNull();
    const text = await C.runLog!({ params: { ...repo, runId: running.id } });
    const live = reduceFrames(parseSse(text).frames);
    expect(live.finished).toBe(false);
    expect(live.jobs.map((job) => job.name)).toEqual([
      "fmt",
      "validate (environments/staging)",
      "validate (environments/production)",
      "lint",
    ]);
    expect(live.jobs[0]!.status).toBe("passed");
    expect(live.jobs.some((job) => job.status === "running")).toBe(true);
  });

  it("reports a commit's statuses from its runs", async () => {
    const S = ci.statuses!;
    const combined = await S.forRef!({ params: repo, query: { ref: "fix/database-backups" } });
    expect(combined.state).toBe("failure");
    expect(combined.statuses.map((status) => [status.context, status.state])).toEqual([
      ["Infrawrench CI / fmt", "failure"],
      ["Infrawrench CI / validate", "success"],
    ]);
    expect(combined.statuses[0]!.targetUrl).toMatch(/^\/acme\/infra\/ci\/runs\//);
  });
});

describe("Terraform", () => {
  it("lists workspaces with their state, lock, last run and cost", async () => {
    const { workspaces } = await T.listWorkspaces!({ params: repo });
    expect(workspaces.map((workspace) => workspace.name)).toEqual(["production", "staging"]);
    const [production, staging] = workspaces;
    expect(production).toMatchObject({
      rootPath: "environments/production",
      lock: null,
      applyRequiresApproval: true,
      driftedCount: 1,
    });
    expect(production!.lastRun).toMatchObject({ operation: "apply", status: "awaiting_approval" });
    expect(production!.currentState).toMatchObject({ serial: 57, current: true });
    expect(staging!.lock).toMatchObject({ who: "jonas@jonas-mbp" });
    expect(staging!.monthlyCost!.amount).toBeGreaterThan(500);
    expect(production!.monthlyCost!.amount).toBeGreaterThan(staging!.monthlyCost!.amount);
    expect(staging!.stateAddress).toMatch(/\/acme\/infra\/terraform\/staging\/state$/);
  });

  it("sums a workspace's cost from its matched resources", async () => {
    const workspace = await T.getWorkspace!({ params: { ...repo, workspace: "staging" } });
    const all = await T.listResources!({
      params: { ...repo, workspace: "staging" },
      query: { limit: 100 },
    });
    const sum = all.items.reduce((total, item) => total + (item.monthlyCost?.amount ?? 0), 0);
    expect(workspace.monthlyCost!.amount).toBeCloseTo(sum, 2);
    expect(workspace.resourceCount).toBe(
      all.items.filter((item) => item.mode === "managed").length,
    );
    const unmatched = await T.listResources!({
      params: { ...repo, workspace: "staging" },
      query: { matched: "false", limit: 100 },
    });
    expect(unmatched.items.every((item) => item.infrawrench === null)).toBe(true);
    const nat = await T.listResources!({
      params: { ...repo, workspace: "staging" },
      query: { q: "nat_gateway" },
    });
    expect(nat.items).toHaveLength(3);
  });

  it("puts a branch page's newest plan per workspace first", async () => {
    const { items } = await T.listRuns!({ params: repo, query: { page: "feature/vpc-peering" } });
    const first = new Map<string, (typeof items)[number]>();
    for (const run of items) if (!first.has(run.workspace.name)) first.set(run.workspace.name, run);
    expect(first.get("staging")).toMatchObject({ status: "planned" });
    expect(first.get("staging")!.plan).toMatchObject({ add: 4, change: 0, destroy: 0 });
    expect(first.get("staging")!.costDelta!.monthlyDelta).toBeLessThan(0);
    expect(first.get("production")).toMatchObject({ status: "no_changes" });
  });

  it("finds the roots that have no workspace", async () => {
    const taken = await T.listRoots!({ params: repo, query: {} });
    expect(taken.roots).toEqual([
      { path: "environments/production", backend: "http", workspaces: ["production"] },
      { path: "environments/staging", backend: "http", workspaces: ["staging"] },
    ]);
    const fork = await T.listRoots!({ params: { owner: "mara", repo: "infra" }, query: {} });
    expect(fork.roots.map((root) => root.workspaces)).toEqual([[], []]);
  });

  it("approves a waiting apply, which writes a state version", async () => {
    const waiting = (await T.listRuns!({ params: repo, query: { status: "awaiting_approval" } }))
      .items[0]!;
    const applied = await T.approveRun!({ params: { ...repo, runId: waiting.id } });
    expect(applied).toMatchObject({ status: "applied" });
    expect(applied.approvedBy?.username).toBe("mara");
    const versions = await T.listStateVersions!({
      params: { ...repo, workspace: "production" },
      query: {},
    });
    expect(versions.items[0]).toMatchObject({ serial: 58, current: true, runId: waiting.id });
    expect(versions.items.filter((version) => version.current)).toHaveLength(1);
  });

  it("offers an approval only on a run that waits, to someone who may approve", async () => {
    const apply = await T.createRun!({
      params: { ...repo, workspace: "production" },
      payload: { operation: "apply" },
    });
    expect(apply).toMatchObject({ status: "awaiting_approval", viewerCanApprove: true });
    const { items } = await T.listRuns!({ params: repo, query: { limit: 50 } });
    const waiting = items.filter((run) => run.status === "awaiting_approval");
    expect(waiting.map((run) => run.id)).toContain(apply.id);
    expect(waiting.every((run) => run.viewerCanApprove === true)).toBe(true);
    await T.discardRun!({ params: { ...repo, runId: apply.id } });
    expect(
      items
        .filter((run) => run.status !== "awaiting_approval")
        .every((run) => run.viewerCanApprove === undefined),
    ).toBe(true);
  });

  it("names a branch page's plans in its timeline, and not the one a newer plan replaced", async () => {
    const { items } = await I.timeline!({ params: { ...repo, number: 12 }, query: { limit: 100 } });
    const runs = items.flatMap((item) => (item.type === "terraform_run" ? [item] : []));
    expect(runs.map((item) => [item.workspace, item.outcome]).sort()).toEqual([
      ["production", "no_changes"],
      ["staging", "planned"],
    ]);
    const staging = runs.find((item) => item.workspace === "staging")!;
    expect([staging.add, staging.change, staging.destroy]).toEqual([4, 0, 0]);
    expect((await T.getRun!({ params: { ...repo, runId: staging.runId } })).branchPage).toBe(
      "feature/vpc-peering",
    );
  });

  it("lists the organisation's accounts for the picker, and none in a personal namespace", async () => {
    const { accounts } = await T.listAccounts!({ params: repo });
    expect(accounts.length).toBeGreaterThan(0);
    const { workspaces } = await T.listWorkspaces!({ params: repo });
    for (const linked of workspaces.flatMap((workspace) => workspace.accounts)) {
      expect(accounts.map((account) => account.accountId)).toContain(linked.accountId);
    }
    const personal = await T.listAccounts!({ params: { owner: "mara", repo: "infra" } });
    expect(personal.accounts).toEqual([]);
  });

  it("starts a plan by hand, and refuses one in a personal namespace", async () => {
    const run = await T.createRun!({
      params: { ...repo, workspace: "staging" },
      payload: { operation: "plan" },
    });
    expect(run).toMatchObject({ operation: "plan", trigger: "manual", status: "queued" });
    expect(run.ref).toBe("main");
    const listed = await T.listRuns!({ params: repo, query: { workspace: "staging" } });
    expect(listed.items[0]?.id).toBe(run.id);
    const elsewhere = await failure(() =>
      T.createRun!({
        params: { ...repo, workspace: "staging" },
        payload: { operation: "apply", ref: "feature/vpc-peering" },
      }),
    );
    expect(elsewhere.status).toBe(422);
    await T.discardRun!({ params: { ...repo, runId: run.id } });
  });

  it("hands out a state version as text, and restores one as a new version", async () => {
    const params = { ...repo, workspace: "production" };
    const before = await T.listStateVersions!({ params, query: {} });
    const old = before.items.find((version) => !version.current)!;
    const text = await T.downloadStateVersion!({ params: { ...params, versionId: old.id } });
    expect(typeof text).toBe("string");
    expect(JSON.parse(text)).toMatchObject({ version: 4, serial: old.serial });
    const restored = await T.restoreStateVersion!({ params: { ...params, versionId: old.id } });
    expect(restored.current).toBe(true);
    expect(restored.serial).toBe(Math.max(...before.items.map((version) => version.serial)) + 1);
    const after = await T.listStateVersions!({ params, query: {} });
    expect(after.items[0]?.id).toBe(restored.id);
    expect(after.items.filter((version) => version.current)).toHaveLength(1);
  });

  it("counts the resources matched to Infrawrench ones", async () => {
    const workspace = await T.getWorkspace!({ params: { ...repo, workspace: "production" } });
    expect(workspace.matchedResourceCount).toBeGreaterThan(0);
    expect(workspace.matchedResourceCount!).toBeLessThanOrEqual(workspace.resourceCount);
  });

  it("refuses to delete a locked workspace until it is unlocked", async () => {
    const params = { ...repo, workspace: "staging" };
    expect((await failure(() => T.deleteWorkspace!({ params }))).code).toBe("terraform_locked");
    await T.forceUnlock!({ params });
    expect((await T.getWorkspace!({ params })).lock).toBeNull();
  });
});

describe("the CI switch", () => {
  it("is on until switched off, and the CI tab then says why nothing runs", async () => {
    expect(await C.settings!({ params: repo })).toEqual({ enabled: true, available: true });
    expect((await C.status!({ params: repo })).enabled).toBe(true);
    expect(await C.updateSettings!({ params: repo, payload: { enabled: false } })).toEqual({
      enabled: false,
      available: true,
    });
    const off = await C.status!({ params: repo });
    expect(off.enabled).toBe(false);
    expect(off.reason).toMatch(/switched off/);
    await C.updateSettings!({ params: repo, payload: { enabled: true } });
    expect((await C.status!({ params: repo })).enabled).toBe(true);
  });

  it("has nothing to switch in a personal namespace", async () => {
    const personal = { owner: "mara", repo: "route-lab" };
    expect(await C.settings!({ params: personal })).toEqual({ enabled: true, available: false });
    const refused = await failure(() =>
      C.updateSettings!({ params: personal, payload: { enabled: false } }),
    );
    expect(refused.code).toBe("ci_unavailable");
  });
});

describe("plan limits", () => {
  const session = async () => (await sessionHandlers.session!.me!({}))!;

  it("carries each namespace's default visibility and whether a private repository fits", async () => {
    const { organizations, personal } = await session();
    const acme = organizations.find((item) => item.namespace === "acme")!;
    const tidewater = organizations.find((item) => item.namespace === "tidewater")!;
    expect(acme).toMatchObject({ privateRepositories: true, privateRepositoryRefusal: null });
    expect(tidewater.defaultVisibility).toBe("public");
    expect(tidewater.privateRepositories).toBe(false);
    expect(tidewater.privateRepositoryRefusal).toBe(
      privateRepositoryRefusal("free", FORGE_LIMITS.free.privateRepositories!),
    );
    expect(personal).toMatchObject({ privateRepositories: true, defaultVisibility: "private" });
  });

  it("refuses a private repository past the plan's limit with the session's own sentence", async () => {
    const { organizations } = await session();
    const tidewater = organizations.find((item) => item.namespace === "tidewater")!;
    const refused = await failure(() =>
      R.create!({ payload: { owner: "tidewater", name: "one-more", visibility: "private" } }),
    );
    expect(refused.status).toBe(402);
    expect(refused.code).toBe("plan_required");
    expect(refused.message).toBe(tidewater.privateRepositoryRefusal);
    expect(refused.message).not.toMatch(/need a paid plan/);
    // A public one is free everywhere.
    const made = await R.create!({
      payload: { owner: "tidewater", name: "one-more", visibility: "public" },
    });
    expect(made.visibility).toBe("public");
  });
});

describe("repository names", () => {
  it("says whether a new repository's name is free where the caller can create", async () => {
    const ask = (name: string) =>
      R.nameAvailability!({ params: { namespace: "acme" }, query: { name } });
    expect(await ask("fresh-name")).toEqual({
      name: "fresh-name",
      available: true,
      reason: null,
      message: null,
    });
    expect(await ask("INFRA")).toMatchObject({ available: false, reason: "taken" });
    expect(await ask(".hidden")).toMatchObject({ available: false, reason: "invalid" });
    const stranger = await failure(() =>
      R.nameAvailability!({ params: { namespace: "jonas" }, query: { name: "edge-router" } }),
    );
    expect(stranger.status).toBe(403);
  });

  it("lets a rename keep the repository's own name and not take a sibling's", async () => {
    const ask = (name: string) => N.renameAvailability!({ params: repo, query: { name } });
    expect(await ask("Infra")).toMatchObject({ available: true });
    expect(await ask("edge-router")).toMatchObject({ available: false, reason: "taken" });
  });
});

describe("settings", () => {
  it("lists what protects main, and the checks a rule can require", async () => {
    const B = repoSettings.protectedBranches!;
    const { rules } = await B.list!({ params: repo });
    expect(rules.map((rule) => [rule.pattern, rule.matchingBranches])).toEqual([
      ["main", ["main"]],
      ["release/*", ["release/2026.11"]],
    ]);
    const { contexts } = await B.statusContexts!({ params: repo });
    expect(contexts).toEqual([
      "Infrawrench CI / fmt",
      "Infrawrench CI / lint",
      "Infrawrench CI / validate",
    ]);
  });

  it("takes an authorized_keys line, titles it by its comment, and refuses it twice", async () => {
    const A = settings.account!;
    const line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHk3Zr0mQp8sT1vXw2yB4dF6hJ9lN mara@desk";
    const key = await A.createKey!({ payload: { key: line } });
    expect(key).toMatchObject({ title: "mara@desk", algorithm: "ssh-ed25519" });
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect((await failure(() => A.createKey!({ payload: { key: line } }))).code).toBe("key_in_use");
    expect((await failure(() => A.createKey!({ payload: { key: "hello" } }))).code).toBe(
      "key_invalid",
    );
  });

  it("shows a new token's secret once and only its prefix afterwards", async () => {
    const A = settings.account!;
    const created = await A.createToken!({
      payload: { name: "ci", scopes: ["repo:read"], expiresInDays: 30 },
    });
    expect(created.secret).toMatch(/^iwg_[0-9a-f]{40}$/);
    expect(created.secret.startsWith(created.token.prefix)).toBe(true);
    const { tokens } = await A.listTokens!({});
    expect(tokens[0]).toEqual(created.token);
    expect(JSON.stringify(tokens)).not.toContain(created.secret);
  });
});
