/**
 * A CI job's note commands on its commit's branch page, against a real
 * Postgres: the app's `landCiNotes` (server-core `ci/git-notes.ts`) writing
 * the rows, and the forge's API reading them back the way a branch page
 * does. Which version they land on, which repository's page and no other,
 * a run again and the next version, what a passing run fixes, what a fork's
 * run may do, and the merge a must-fix from CI holds.
 *
 * Nothing here runs a job: a run is its row and a report's jobs, as the
 * app has them when a run ends.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type NotesJob, type NotesRun, landCiNotes } from "@infrawrench/server-core/ci/git-notes";
import {
  gitInstructions,
  gitReviewFindings,
  gitTraceEntries,
} from "@infrawrench/server-core/db/schema";
import { db, newId } from "../../db/client";
import type { GitPushEvent } from "../../env";
import { handlePush } from "../../events/consumer";
import { type Person, type World, configured, makeWorld, pagePath } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ZERO = "0".repeat(40);

describe.skipIf(!configured)("CI notes on a branch page, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person;
  let organization: { id: string; slug: string };
  let repo: string;
  let id: string;
  let count = 0;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob] = (await Promise.all(["alice", "bob"].map((name) => world.person(name)))) as [
      Person,
      Person,
    ];
    organization = await world.organization("noted", { paid: true, members: [[alice, "owner"]] });
  });
  afterAll(async () => {
    await world?.cleanup();
  });
  beforeEach(async () => {
    const made = await world.repository(alice, organization.slug, `noted-${++count}`);
    repo = made.path;
    id = made.id;
  });

  /** Move a branch in the storage, as a push does, and deliver its event. */
  const push = async (branch: string, repositoryId = id) => {
    const at = Date.now();
    const newOid = world.storage.nextOid();
    world.storage.commits.set(newOid, { message: "A change", email: alice.email });
    const oldOid =
      world.storage.moveBranch(repositoryId, branch, newOid, { forced: false, at }) ?? ZERO;
    const event: GitPushEvent = {
      type: "push",
      repoId: repositoryId,
      actor: { kind: "user", userId: alice.id, credentialId: null },
      updates: [{ name: `refs/heads/${branch}`, oldOid, newOid, forced: false }],
      at,
    };
    await handlePush(event, world.env, world.storage.readers);
    return newOid;
  };

  const pullOf = async (branch: string, path = repo) => {
    const [page] = (
      await world.call("GET", `${path}/branch-pages?state=all&head=${branch}`, { as: alice })
    ).body.items as Array<Record<string, any>>;
    return { id: page!["id"] as string, path: pagePath(path, page!["key"]) };
  };
  const findingsOf = async (pull: string) =>
    (await world.call("GET", `${pull}/findings`, { as: alice })).body as {
      findings: Array<Record<string, any>>;
      tally: Record<string, number>;
    };
  const traceOf = async (branch: string) =>
    (await world.call("GET", `${repo}/traces?branch=${branch}`, { as: alice })).body.items as Array<
      Record<string, any>
    >;
  const blockers = async (pull: string) =>
    (
      (await world.call("GET", pull, { as: alice })).body.mergeability.blockers as Array<{
        code: string;
      }>
    ).map((blocker) => blocker.code);

  /** A push run of `branch` at `sha`, as its row says it. */
  const run = (branch: string, sha: string, over: Partial<NotesRun> = {}): NotesRun => ({
    id: newId(),
    gitRepositoryId: id,
    repoFullName: repo.replace(/^\/api\/repos\//, "").replace(/^\//, ""),
    event: "push",
    headRef: branch,
    sha,
    pullNumber: null,
    fromFork: false,
    terraformRunId: null,
    ...over,
  });
  const job = (lines: string[], over: Partial<NotesJob> = {}): NotesJob => ({
    pipeline: "lint",
    id: "eslint",
    status: "passed",
    cached: false,
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
    ...over,
  });

  const MUST_FIX = "::must-fix file=src/db.ts,line=4,title=Unbounded query::No LIMIT on this read.";
  const SHOULD_FIX = "::should-fix file=src/db.ts,line=9::Name this constant.";

  it("writes findings and trace entries on the version whose commit the run is of", async () => {
    const first = await push("feature");
    const second = await push("feature");
    const pull = await pullOf("feature");

    // The run of the first commit finishes after the second was pushed.
    const late = await landCiNotes(run("feature", first), [
      job(["compiling", MUST_FIX, "::doubt file=src/db.ts,line=4::Is this index still used?"]),
    ]);
    expect(late).toMatchObject({ skipped: null, findings: 1, traceEntries: 1 });

    const { findings, tally } = await findingsOf(pull.path);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reviewerKind: "ci:lint/eslint",
      severity: "must_fix",
      title: "Unbounded query",
      body: "No LIMIT on this read.",
      path: "src/db.ts",
      startLine: 4,
      needsCode: true,
      commitOid: first,
      version: 1,
      lastSeenVersion: 1,
      status: "open",
    });
    expect(findings[0]!["evidence"]).toEqual([
      {
        kind: "ci",
        text: "Reported by the job eslint of the pipeline lint, on line 2 of its log.",
        url: expect.stringMatching(/\/ci\/runs\/[0-9a-f-]+\?job=lint%2Feslint#L2$/),
      },
    ]);
    expect(tally).toMatchObject({ mustFixOpen: 1 });

    const trace = await traceOf("feature");
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      kind: "doubt",
      body: "Is this index still used?",
      version: 1,
      author: null,
      needsCode: true,
      agent: { kind: "ci", name: "lint/eslint" },
      anchors: [{ path: "src/db.ts", startLine: 4, endLine: null }],
    });
    expect(trace[0]!["evidence"]).toMatchObject({
      ciRunId: expect.any(String),
      url: expect.stringMatching(/#L3$/),
    });

    // The second commit's own run: the same finding, seen again, on version 2.
    await landCiNotes(run("feature", second), [job([MUST_FIX])]);
    const after = await findingsOf(pull.path);
    expect(after.findings).toHaveLength(1);
    expect(after.findings[0]).toMatchObject({ version: 1, lastSeenVersion: 2, commitOid: second });
  });

  it("leaves nothing for a commit that is no version's, a branch with no page, or another source", async () => {
    const sha = await push("feature");
    expect(await landCiNotes(run("feature", "f".repeat(40)), [job([MUST_FIX])])).toMatchObject({
      skipped: "no-version",
    });
    expect(await landCiNotes(run("nowhere", sha), [job([MUST_FIX])])).toMatchObject({
      skipped: "no-page",
    });
    expect(await landCiNotes(run("main", sha), [job([MUST_FIX])])).toMatchObject({
      skipped: "no-page",
    });
    expect(
      await landCiNotes(run("feature", sha, { gitRepositoryId: null }), [job([MUST_FIX])]),
    ).toMatchObject({ skipped: "not-forge" });
    expect(
      await landCiNotes(run("feature", sha, { terraformRunId: "tf-1" }), [job([MUST_FIX])]),
    ).toMatchObject({ skipped: "not-forge" });
    // A closed page takes no more notes.
    const pull = await pullOf("feature");
    await world.call("POST", `${pull.path}/close`, { as: alice });
    expect(await landCiNotes(run("feature", sha), [job([MUST_FIX])])).toMatchObject({
      skipped: "no-page",
    });
    expect((await findingsOf(pull.path)).findings).toEqual([]);
  });

  it("never writes on another repository's page", async () => {
    const sha = await push("feature");
    const pull = await pullOf("feature");
    const other = await world.repository(alice, organization.slug, `elsewhere-${count}`);
    const otherSha = await push("feature", other.id);

    // A run of the other repository, of a branch of the same name, at this repository's commit.
    const stray = await landCiNotes(run("feature", sha, { gitRepositoryId: other.id }), [
      job([MUST_FIX]),
    ]);
    expect(stray.skipped).toBe("no-version");
    expect((await findingsOf(pull.path)).findings).toEqual([]);

    // Its own commit lands on its own page, and only there.
    await landCiNotes(run("feature", otherSha, { gitRepositoryId: other.id }), [job([MUST_FIX])]);
    expect((await findingsOf(pull.path)).findings).toEqual([]);
    const otherPull = await pullOf("feature", other.path);
    expect((await findingsOf(otherPull.path)).findings).toHaveLength(1);

    // A page's own run names a page by number in its repository: this one's number there is another page.
    const number = (await world.call("GET", pull.path, { as: alice })).body.number as number;
    const crossed = await landCiNotes(
      run("feature", sha, { gitRepositoryId: other.id, event: "pull-request", pullNumber: number }),
      [job([SHOULD_FIX])],
    );
    expect(crossed.findings).toBe(0);
    expect((await findingsOf(pull.path)).findings).toEqual([]);
  });

  it("updates a finding when the job runs again, and keeps two of one title apart", async () => {
    const sha = await push("feature");
    const pull = await pullOf("feature");
    const twice = [
      "::should-fix file=src/a.ts,line=3,title=Unexpected any::first",
      "::should-fix file=src/a.ts,line=8,title=Unexpected any::second",
    ];
    await landCiNotes(run("feature", sha), [job(twice)]);
    const before = (await findingsOf(pull.path)).findings;
    expect(before.map((finding) => finding["startLine"])).toEqual([3, 8]);

    // The same output from a run again: the same two rows, pointing at the new run.
    const again = run("feature", sha);
    await landCiNotes(again, [job(twice)]);
    const after = (await findingsOf(pull.path)).findings;
    expect(after.map((finding) => finding["id"])).toEqual(before.map((finding) => finding["id"]));
    expect(after[0]!["evidence"][0].url).toContain(again.id);

    // And one line moved on the next version: still the same rows.
    const next = await push("feature");
    await landCiNotes(run("feature", next), [
      job([
        "::should-fix file=src/a.ts,line=5,title=Unexpected any::first",
        "::should-fix file=src/a.ts,line=10,title=Unexpected any::second",
      ]),
    ]);
    const moved = (await findingsOf(pull.path)).findings;
    expect(moved.map((finding) => finding["id"])).toEqual(before.map((finding) => finding["id"]));
    expect(moved.map((finding) => [finding["startLine"], finding["lastSeenVersion"]])).toEqual([
      [5, 2],
      [10, 2],
    ]);
  });

  it("replaces a job's trace entries when it runs again, and leaves an agent's alone", async () => {
    const sha = await push("feature");
    await world.call("POST", `${repo}/traces`, {
      as: alice,
      body: { branch: "feature", entries: [{ kind: "step", body: "an agent's own" }] },
    });
    await landCiNotes(run("feature", sha), [job(["::step::built", "::evidence::12 tests passed"])]);
    await landCiNotes(run("feature", sha), [
      job(["::evidence::13 tests passed"]),
      job(["::decision::skipped the slow suite"], { id: "unit", pipeline: "test" }),
    ]);
    const trace = await traceOf("feature");
    expect(trace.map((entry) => [entry["agent"]?.name ?? null, entry["body"]]).sort()).toEqual(
      [
        [null, "an agent's own"],
        ["lint/eslint", "13 tests passed"],
        ["test/unit", "skipped the slow suite"],
      ].sort(),
    );
  });

  it("marks a job's findings fixed when it passes without them, and only that job's", async () => {
    const first = await push("feature");
    const pull = await pullOf("feature");
    await landCiNotes(run("feature", first), [
      job([MUST_FIX, SHOULD_FIX], { status: "failed" }),
      job(["::must-fix file=t.ts,line=1::A test is skipped."], { pipeline: "test", id: "unit" }),
    ]);
    // Another reviewer's finding on the same page.
    await world.call("POST", `${pull.path}/findings`, {
      as: alice,
      body: {
        reviewerKind: "codeql",
        findings: [{ severity: "should_fix", title: "Somebody else's" }],
      },
    });

    // The next version: the linter fails again without the should-fix. A failed job fixes nothing.
    const second = await push("feature");
    const failed = await landCiNotes(run("feature", second), [
      job([MUST_FIX], { status: "failed" }),
    ]);
    expect(failed.fixed).toBe(0);

    // It passes with nothing to say: both of its findings are fixed, in that version.
    const third = await push("feature");
    const passed = await landCiNotes(run("feature", third), [job(["all clean"])]);
    expect(passed.fixed).toBe(2);
    const byTitle = new Map(
      (await findingsOf(pull.path)).findings.map((finding) => [finding["title"], finding]),
    );
    expect(byTitle.get("Unbounded query")).toMatchObject({ status: "fixed", fixedInVersion: 3 });
    expect(byTitle.get("Name this constant.")).toMatchObject({
      status: "fixed",
      fixedInVersion: 3,
    });
    // The other job did not run in that run, and the other reviewer is not CI: both untouched.
    expect(byTitle.get("A test is skipped.")).toMatchObject({ status: "open" });
    expect(byTitle.get("Somebody else's")).toMatchObject({ status: "open" });

    // Raised again later, it is the same row, reopened.
    const fourth = await push("feature");
    await landCiNotes(run("feature", fourth), [job([MUST_FIX], { status: "failed" })]);
    const reopened = (await findingsOf(pull.path)).findings.find(
      (finding) => finding["title"] === "Unbounded query",
    );
    expect(reopened).toMatchObject({
      id: byTitle.get("Unbounded query")!["id"],
      status: "open",
      fixedInVersion: null,
      lastSeenVersion: 4,
    });
  });

  it("fixes on the same version when the job is run again and passes clean", async () => {
    const sha = await push("feature");
    const pull = await pullOf("feature");
    await landCiNotes(run("feature", sha), [job([MUST_FIX], { status: "failed" })]);
    expect(await blockers(pull.path)).toContain("must_fix_findings");
    await landCiNotes(run("feature", sha), [job(["all clean"])]);
    expect((await findingsOf(pull.path)).findings[0]).toMatchObject({
      status: "fixed",
      fixedInVersion: 1,
    });
    expect(await blockers(pull.path)).not.toContain("must_fix_findings");
  });

  it("carries a cached job's findings, and leaves a skipped or cancelled job's as they are", async () => {
    const first = await push("feature");
    const pull = await pullOf("feature");
    await landCiNotes(run("feature", first), [job([SHOULD_FIX])]);
    const second = await push("feature");
    const outcome = await landCiNotes(run("feature", second), [
      job([], { cached: true, stdout: "" }),
    ]);
    expect(outcome).toMatchObject({ carried: 1, fixed: 0 });
    expect((await findingsOf(pull.path)).findings[0]).toMatchObject({
      status: "open",
      lastSeenVersion: 2,
      commitOid: second,
    });
    const third = await push("feature");
    for (const status of ["skipped", "cancelled", "error"]) {
      await landCiNotes(run("feature", third), [job([MUST_FIX], { status })]);
    }
    const findings = (await findingsOf(pull.path)).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ status: "open", lastSeenVersion: 2 });
  });

  it("leaves a dismissed finding dismissed when the job reports it again", async () => {
    const first = await push("feature");
    const pull = await pullOf("feature");
    await landCiNotes(run("feature", first), [job([SHOULD_FIX])]);
    const [finding] = (await findingsOf(pull.path)).findings;
    await world.call("PUT", `${pull.path}/findings/${finding!["id"]}/dismiss`, {
      as: alice,
      body: { reason: "Deliberate." },
    });
    const second = await push("feature");
    await landCiNotes(run("feature", second), [job([SHOULD_FIX])]);
    expect((await findingsOf(pull.path)).findings[0]).toMatchObject({
      status: "dismissed",
      dismissalReason: "Deliberate.",
    });
  });

  it("holds the merge on a must-fix from CI until it is fixed or overridden, and tells the agent", async () => {
    const sha = await push("feature");
    const pull = await pullOf("feature");
    await world.call("PUT", `${pull.path}/draft`, { as: alice, body: { draft: false } });
    await world.call("PUT", `${pull.path}/agent`, {
      as: alice,
      body: { kind: "mcp", displayName: "Claude Code" },
    });
    expect(await blockers(pull.path)).toEqual([]);

    await landCiNotes(run("feature", sha), [job([MUST_FIX], { status: "failed" })]);
    expect(await blockers(pull.path)).toEqual(["must_fix_findings"]);
    expect(
      await world.call("POST", `${pull.path}/merge`, { as: alice, body: { method: "merge" } }),
    ).toMatchObject({ status: 422, body: { code: "must_fix_findings" } });
    // It went to the page's agent by itself, once, however often the job runs.
    await landCiNotes(run("feature", sha), [job([MUST_FIX], { status: "failed" })]);
    const sent = await db
      .select()
      .from(gitInstructions)
      .where(eq(gitInstructions.pullRequestId, pull.id));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: "finding", status: "queued" });
    expect(sent[0]!.body).toContain("Found by the ci:lint/eslint reviewer.");

    // An administrator may let the merge past it, as past any must-fix.
    expect(
      (
        await world.call("POST", `${pull.path}/findings/override`, {
          as: alice,
          body: { reason: "Shipping the fix separately." },
        })
      ).status,
    ).toBe(200);
    expect(await blockers(pull.path)).toEqual([]);
  });

  it("masks what a note says before it is stored", async () => {
    const sha = await push("feature");
    await landCiNotes(run("feature", sha), [
      job([
        // The runner's mask stays as it is; a credential by its shape is caught here too.
        "::must-fix file=.env,line=1,title=Key *** is committed::API_TOKEN=hunter2-value and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "::doubt::Is postgres://app:s3cretpass@db.internal/app meant to be here?",
      ]),
    ]);
    const stored = JSON.stringify([
      await db.select().from(gitReviewFindings).where(eq(gitReviewFindings.repositoryId, id)),
      await db.select().from(gitTraceEntries).where(eq(gitTraceEntries.repositoryId, id)),
    ]);
    expect(stored).toContain("Key *** is committed");
    for (const secret of [
      "hunter2-value",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "s3cretpass",
    ]) {
      expect(stored).not.toContain(secret);
    }
  });

  describe("a fork's proposed branch", () => {
    const forked = async () => {
      const name = `fork-${count}`;
      const fork = await world.call("POST", `${repo}/forks`, {
        as: bob,
        body: { owner: bob.username, name },
      });
      const forkId = fork.body.id as string;
      world.storage
        .repository(forkId)
        .branches.set("main", world.storage.repository(id).branches.get("main")!);
      const sha = await push("patch", forkId);
      const proposed = await world.call("POST", `${repo}/branch-pages`, {
        as: bob,
        body: { head: "patch", headRepository: `${bob.username}/${name}` },
      });
      expect(proposed.status).toBe(200);
      return {
        forkId,
        sha,
        number: proposed.body.number as number,
        path: pagePath(repo, proposed.body.key as string),
        fullName: `${bob.username}/${name}`,
      };
    };

    it("gets findings from its untrusted run, and no trace entries", async () => {
      const fork = await forked();
      const outcome = await landCiNotes(
        run("patch", fork.sha, {
          event: "pull-request",
          pullNumber: fork.number,
          fromFork: true,
        }),
        [job([MUST_FIX, "::doubt::From the fork."], { status: "failed" })],
      );
      expect(outcome).toMatchObject({ findings: 1, traceEntries: 0, traceRefused: 1 });
      expect((await findingsOf(fork.path)).findings[0]).toMatchObject({
        reviewerKind: "ci:lint/eslint",
        severity: "must_fix",
      });
      expect(await blockers(fork.path)).toContain("must_fix_findings");
      expect(
        await db.select().from(gitTraceEntries).where(eq(gitTraceEntries.repositoryId, id)),
      ).toEqual([]);
    });

    it("fixes only what its own jobs reported", async () => {
      const fork = await forked();
      // Somebody with write on the base reports under a name of their own.
      await world.call("POST", `${fork.path}/findings`, {
        as: alice,
        body: {
          reviewerKind: "codeql",
          findings: [{ severity: "must_fix", title: "From the base's reviewer" }],
        },
      });
      const forkRun = () =>
        run("patch", fork.sha, { event: "pull-request", pullNumber: fork.number, fromFork: true });
      await landCiNotes(forkRun(), [job([MUST_FIX], { status: "failed" })]);
      // The fork renames its job to the other reviewer's name and passes clean.
      const outcome = await landCiNotes(forkRun(), [
        job(["clean"], { pipeline: "codeql", id: "codeql" }),
        job(["clean"]),
      ]);
      expect(outcome.fixed).toBe(1);
      const byReviewer = new Map(
        (await findingsOf(fork.path)).findings.map((finding) => [finding["reviewerKind"], finding]),
      );
      expect(byReviewer.get("ci:lint/eslint")).toMatchObject({ status: "fixed" });
      expect(byReviewer.get("codeql")).toMatchObject({ status: "open" });
      expect(await blockers(fork.path)).toContain("must_fix_findings");
    });

    it("is not written on by the fork's own push run", async () => {
      const fork = await forked();
      // The fork's repository runs CI for its own push: that run is the fork's, not the page's.
      const outcome = await landCiNotes(
        run("patch", fork.sha, { gitRepositoryId: fork.forkId, repoFullName: fork.fullName }),
        [job([MUST_FIX])],
      );
      expect(outcome.skipped).toBe("no-page");
      expect((await findingsOf(fork.path)).findings).toEqual([]);
    });

    it("is not written on by a run that says it is not a fork's", async () => {
      const fork = await forked();
      const outcome = await landCiNotes(
        run("patch", fork.sha, { event: "pull-request", pullNumber: fork.number }),
        [job([MUST_FIX])],
      );
      expect(outcome.skipped).toBe("no-page");
    });
  });

  describe("the names CI writes under", () => {
    it("are refused to a reviewer that reports through the API", async () => {
      await push("feature");
      const pull = await pullOf("feature");
      const answer = await world.call("POST", `${pull.path}/findings`, {
        as: alice,
        body: {
          reviewerKind: "ci:lint/eslint",
          complete: true,
          findings: [],
        },
      });
      expect(answer.status).toBe(422);
      const job = await world.call("POST", `${pull.path}/findings`, {
        job: { repositoryId: id, write: true },
        body: { reviewerKind: "ci:lint/eslint", findings: [] },
      });
      expect(job.status).toBe(422);
    });

    it("are refused to an agent that records a trace", async () => {
      await push("feature");
      const answer = await world.call("POST", `${repo}/traces`, {
        as: alice,
        body: {
          branch: "feature",
          agent: { kind: "ci", name: "lint/eslint" },
          entries: [{ kind: "doubt", body: "Not from CI." }],
        },
      });
      expect(answer.status).toBe(422);
    });
  });
});
