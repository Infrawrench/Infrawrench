/**
 * Review agents against a real Postgres: a push queueing a run, the runner
 * with a scripted model in place of Claude (findings written through tool
 * calls, fixed and dismissed ones on the next version, the budget, a model
 * that fails, a message delivered twice), the findings endpoints, and the
 * must-fix merge block with its override, end to end through mergeability.
 *
 * Nothing here reaches a model or any other service: the model is a script,
 * and the one test that reports usage to Stripe replaces `fetch`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  gitBranchVersions,
  gitInstructions,
  gitReviewFindings,
  gitReviewRuns,
  gitTraceEntries,
  organizations,
  subscriptions,
  workflowAiUsage,
} from "@infrawrench/server-core/db/schema";
import { GIT_REVIEW_NOT_BILLED, reportGitReviewUsage } from "@infrawrench/server-core/git/billing";
import { db, newId } from "../../db/client";
import type { GitPushEvent } from "../../env";
import { handlePush } from "../../events/consumer";
import type { ReviewModel } from "../../review/model";
import { REVIEW_LIMITS } from "../../review/policy";
import { sweepReviewRuns } from "../../review/queue";
import { SPEND_CAP_REACHED, reviewUsageSource, runReview } from "../../review/runner";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ZERO = "0".repeat(40);

type Call = { readonly name: string; readonly input: Record<string, unknown> };
type Turn = readonly Call[] | "end" | "refuse" | Error;

/** A model that plays a script: each turn is tool calls to make, the end, a decline, or a failure. */
const scripted = (turns: readonly Turn[]) => {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let at = 0;
  const model: ReviewModel = {
    create: async (params) => {
      // What is sent, as it was when it was sent.
      requests.push(structuredClone(params));
      const turn = turns[at++] ?? "end";
      if (turn instanceof Error) throw turn;
      const calls = turn === "end" || turn === "refuse" ? [] : turn;
      return {
        id: `msg_${at}`,
        type: "message",
        role: "assistant",
        model: params.model,
        content: [
          { type: "text", text: "Looking.", citations: null },
          ...calls.map((call, index) => ({
            type: "tool_use" as const,
            id: `toolu_${at}_${index}`,
            name: call.name,
            input: call.input,
          })),
        ],
        stop_reason: turn === "refuse" ? "refusal" : calls.length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 500,
        },
      } as unknown as Anthropic.Message;
    },
  };
  /** What the tools answered, in order, as the model was shown them. */
  const toolResults = (): string[] =>
    (requests.at(-1)?.messages ?? []).flatMap((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? message.content.flatMap((block) =>
            block.type === "tool_result" && typeof block.content === "string"
              ? [block.content]
              : [],
          )
        : [],
    );
  return { model, requests, toolResults };
};

describe.skipIf(!configured)("review agents, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person;
  let organization: { id: string; slug: string };
  let repo: string;
  let id: string;
  let count = 0;

  beforeAll(async () => {
    // Enough for the forge to say Claude is configured. Nothing calls it: the model is a script.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
    vi.stubEnv("AI_GATEWAY_ID", "test-gateway");
    vi.stubEnv("AI_GATEWAY_TOKEN", "test-gateway-token");
    world = makeWorld();
    [alice, bob, carol] = (await Promise.all(
      ["alice", "bob", "carol"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
    organization = await world.organization("reviewed", {
      paid: true,
      members: [[alice, "owner"]],
    });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await world?.cleanup();
  });
  beforeEach(async () => {
    const made = await world.repository(alice, organization.slug, `reviewed-${++count}`);
    repo = made.path;
    id = made.id;
    // Bob writes and triages; Carol only reads (the repository is public).
    await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });
    await db
      .update(organizations)
      .set({ chatMonthlyCapMicros: null })
      .where(eq(organizations.id, organization.id));
  });

  const enable = (reviewerKinds: string[] = ["general"]) =>
    world.call("PATCH", `${repo}/review-settings`, {
      as: alice,
      body: { reviewAgentsEnabled: true, reviewerKinds },
    });

  /** Move a branch in the storage, as a push does, and deliver its event twice. */
  const push = async (branch: string, options: { in?: string; by?: Person } = {}) => {
    const repositoryId = options.in ?? id;
    const at = Date.now();
    const newOid = world.storage.nextOid();
    world.storage.commits.set(newOid, { message: "A change", email: alice.email });
    const oldOid =
      world.storage.moveBranch(repositoryId, branch, newOid, { forced: false, at }) ?? ZERO;
    const event: GitPushEvent = {
      type: "push",
      repoId: repositoryId,
      actor: { kind: "user", userId: (options.by ?? alice).id, credentialId: null },
      updates: [{ name: `refs/heads/${branch}`, oldOid, newOid, forced: false }],
      at,
    };
    await handlePush(event, world.env, world.storage.readers);
    await handlePush(event, world.env, world.storage.readers);
    return newOid;
  };

  const pullOf = async (branch: string, path = repo) => {
    const [page] = (
      await world.call("GET", `${path}/pulls?state=all&head=${branch}`, { as: alice })
    ).body.items as Array<Record<string, any>>;
    return { id: page!["id"] as string, path: `${path}/pulls/${page!["number"]}` };
  };
  const runsOf = (pullRequestId: string) =>
    db
      .select()
      .from(gitReviewRuns)
      .where(eq(gitReviewRuns.pullRequestId, pullRequestId))
      .orderBy(gitReviewRuns.createdAt);
  const findingsOf = async (pull: string, as: Person = alice) =>
    (await world.call("GET", `${pull}/findings`, { as })).body as {
      findings: Array<Record<string, any>>;
      tally: Record<string, number>;
    };
  const blockers = async (pull: string) =>
    (
      (await world.call("GET", pull, { as: alice })).body.mergeability.blockers as Array<{
        code: string;
      }>
    ).map((blocker) => blocker.code);
  const review = (runId: string, model: ReviewModel, options: Record<string, unknown> = {}) =>
    runReview(runId, {
      env: world.env,
      readers: world.storage.readers,
      model: () => model,
      configured: true,
      ...options,
    });

  /** A branch with a page that is not a draft, review agents on, and the run its first version queued. */
  const reviewed = async (branch = "feature", kinds?: string[]) => {
    await enable(kinds);
    await push(branch);
    const pull = await pullOf(branch);
    await world.call("PUT", `${pull.path}/draft`, { as: alice, body: { draft: false } });
    const [run] = await runsOf(pull.id);
    return { pull, run: run! };
  };

  const MUST_FIX: Call = {
    name: "report_finding",
    input: {
      severity: "must_fix",
      title: "Retry logs the bearer token",
      body: "The retry path writes the whole request, header included.",
      path: "src/retry.ts",
      start_line: 12,
      end_line: 14,
      evidence: [
        {
          kind: "code",
          text: 'log.info(request) // prints Authorization: Bearer abcdefgh12345678 and API_TOKEN="hunter2-value"',
        },
      ],
    },
  };

  describe("a push", () => {
    it("queues one run for a new version, however often the push is delivered", async () => {
      await enable(["general", "security", "somebody-elses"]);
      const tip = await push("feature");
      const pull = await pullOf("feature");
      const runs = await runsOf(pull.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "queued",
        trigger: "push",
        versionNumber: 1,
        headOid: tip,
        // Only the forge's own reviewers are the forge's to run.
        reviewerKinds: ["general", "security"],
        requestedByUserId: alice.id,
      });
      expect(
        (await world.call("GET", `${pull.path}/branch-state`, { as: alice })).body,
      ).toMatchObject({ reviewRun: "queued" });
    });

    it("drops an older version's run that never started, and leaves a finished one", async () => {
      const { pull, run } = await reviewed();
      await push("feature");
      const afterSecond = await runsOf(pull.id);
      expect(afterSecond.map((row) => [row.versionNumber, row.status])).toEqual([[2, "queued"]]);
      expect(afterSecond[0]!.id).not.toBe(run.id);
      // The message of the run that is gone does nothing.
      expect(await review(run.id, scripted([]).model)).toBe("ignored");

      expect(await review(afterSecond[0]!.id, scripted(["end"]).model)).toBe("done");
      await push("feature");
      expect((await runsOf(pull.id)).map((row) => [row.versionNumber, row.status])).toEqual([
        [2, "done"],
        [3, "queued"],
      ]);
    });

    it("queues nothing while review agents are off, or in a person's own repository", async () => {
      await push("quiet");
      expect(await runsOf((await pullOf("quiet")).id)).toEqual([]);

      const own = await world.repository(alice, alice.username, `own-${count}`);
      await world.call("PATCH", `${own.path}/review-settings`, {
        as: alice,
        body: { reviewAgentsEnabled: true },
      });
      await push("feature", { in: own.id });
      const pull = await pullOf("feature", own.path);
      expect(await runsOf(pull.id)).toEqual([]);
      // And nobody can ask for one there.
      expect(
        await world.call("POST", `${pull.path}/review-runs`, { as: alice, body: {} }),
      ).toMatchObject({ status: 422, body: { error: expect.stringContaining("organisation") } });
    });
  });

  describe("a run", () => {
    it("writes what the model reports, masked, and holds the merge on a must-fix finding", async () => {
      const { pull, run } = await reviewed();
      world.storage.repository(id).files.set("src/retry.ts", "one\ntwo\nthree");
      await world.call("PUT", `${pull.path}/agent`, {
        as: alice,
        body: { kind: "mcp", displayName: "Claude Code" },
      });
      expect(await blockers(pull.path)).toEqual([]);

      const script = scripted([
        [
          { name: "list_findings", input: {} },
          { name: "read_diff", input: { scope: "whole" } },
          { name: "read_file", input: { path: "src/retry.ts" } },
          { name: "read_file", input: { path: "../outside" } },
        ],
        [
          MUST_FIX,
          {
            name: "report_finding",
            input: { severity: "note", title: "Is the cache key stable?", body: "" },
          },
          // A must-fix has to say how it is known.
          {
            name: "report_finding",
            input: { severity: "must_fix", title: "Probably wrong", body: "A feeling." },
          },
        ],
        "end",
      ]);
      expect(await review(run.id, script.model)).toBe("done");

      const results = script.toolResults();
      expect(results[0]).toBe("Nothing has been found on this pull request yet.");
      expect(results[1]).toContain("The whole change at version 1");
      expect(results[2]).toContain("1\tone\n2\ttwo\n3\tthree");
      expect(results[3]).toContain("cannot contain `..`");
      expect(results[4]).toMatch(/^Recorded as /);
      expect(results[6]).toContain("needs evidence");
      // The system prompt and the tools are the same bytes every turn, and cached.
      expect(script.requests).toHaveLength(3);
      expect(script.requests[0]!.model).toBe("claude-opus-5-5");
      expect(script.requests[0]!.system).toEqual(script.requests[2]!.system);
      expect(JSON.stringify(script.requests[0]!.system)).toContain("cache_control");
      // The description is the author's, fenced as such.
      expect(JSON.stringify(script.requests[0]!.messages[0])).toContain(
        "<pull_request_description>",
      );

      const { findings, tally } = await findingsOf(pull.path, carol);
      expect(findings).toHaveLength(2);
      // About the whole change first, then by file.
      expect(findings[0]).toMatchObject({
        severity: "note",
        title: "Is the cache key stable?",
        path: null,
        evidence: [],
        status: "open",
        viewerCanDismiss: false,
      });
      expect(findings[1]).toMatchObject({
        reviewerKind: "general",
        severity: "must_fix",
        path: "src/retry.ts",
        startLine: 12,
        endLine: 14,
        version: 1,
        lastSeenVersion: 1,
        overridden: false,
        runId: run.id,
      });
      const evidence = findings[1]!["evidence"][0].text as string;
      expect(evidence).not.toContain("abcdefgh12345678");
      expect(evidence).not.toContain("hunter2-value");
      expect(evidence).toContain("Bearer ***");
      expect(tally).toMatchObject({ found: 2, open: 2, mustFixOpen: 1, needsPerson: 1 });

      // The run: finished, with what it used, billed to the organisation's AI spend.
      const stored = (await world.call("GET", `${pull.path}/review-runs/${run.id}`, { as: carol }))
        .body;
      expect(stored).toMatchObject({
        status: "done",
        version: 1,
        model: "claude-opus-5-5",
        findingCount: 2,
        error: null,
        usage: { inputTokens: 4500, outputTokens: 600 },
      });
      expect(stored.usage.costUsd).toBeGreaterThan(0);
      expect(stored.finishedAt).not.toBeNull();
      const usage = await db
        .select()
        .from(workflowAiUsage)
        .where(eq(workflowAiUsage.runId, run.id));
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        organizationId: organization.id,
        workflowId: reviewUsageSource(id),
        inputTokens: 3000,
        cacheReadTokens: 1500,
        outputTokens: 600,
      });
      expect(usage[0]!.costMicros).toBe(Math.round(stored.usage.costUsd * 1_000_000));

      // The must-fix finding holds the merge, and went back to the agent by itself.
      expect(await blockers(pull.path)).toEqual(["must_fix_findings"]);
      expect(
        await world.call("POST", `${pull.path}/merge`, { as: alice, body: { method: "merge" } }),
      ).toMatchObject({ status: 422, body: { code: "must_fix_findings" } });
      const instructions = await db
        .select()
        .from(gitInstructions)
        .where(eq(gitInstructions.pullRequestId, pull.id));
      expect(instructions).toHaveLength(1);
      expect(instructions[0]).toMatchObject({
        source: "finding",
        findingId: findings[1]!["id"],
        status: "queued",
        createdByUserId: null,
      });
      expect(instructions[0]!.body).toContain("Must fix: Retry logs the bearer token");
      expect(instructions[0]!.body).not.toContain("hunter2-value");
    });

    it("marks a finding fixed in the version that fixes it, and reopens it if it comes back", async () => {
      const { pull, run } = await reviewed();
      await review(run.id, scripted([[MUST_FIX], "end"]).model);
      const [finding] = (await findingsOf(pull.path)).findings;

      await push("feature");
      const [, second] = await runsOf(pull.id);
      const recheck = scripted([
        [{ name: "list_findings", input: {} }],
        [{ name: "recheck_finding", input: { finding_id: finding!["id"], verdict: "fixed" } }],
        "end",
      ]);
      expect(await review(second!.id, recheck.model)).toBe("done");
      // It was told what it had open, and to recheck it.
      expect(JSON.stringify(recheck.requests[0]!.messages[0])).toContain("1 open finding");
      expect(recheck.toolResults()[0]).toContain(`${finding!["id"]} [general, yours] must_fix`);
      expect((await findingsOf(pull.path)).findings[0]).toMatchObject({
        status: "fixed",
        version: 1,
        lastSeenVersion: 1,
        fixedInVersion: 2,
      });
      expect(await blockers(pull.path)).toEqual([]);
      expect((await findingsOf(pull.path)).tally).toMatchObject({ fixed: 1, mustFixOpen: 0 });
      // Seen on version 1 only.
      expect((await world.call("GET", `${pull.path}/findings?version=2`)).body.findings).toEqual(
        [],
      );
      expect(
        (await world.call("GET", `${pull.path}/findings?version=1&status=fixed`)).body.findings,
      ).toHaveLength(1);

      await push("feature");
      const [, , third] = await runsOf(pull.id);
      const again = scripted([[MUST_FIX], "end"]);
      await review(third!.id, again.model);
      expect(again.toolResults()[0]).toContain("open again");
      const all = (await findingsOf(pull.path)).findings;
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        id: finding!["id"],
        status: "open",
        version: 1,
        lastSeenVersion: 3,
        fixedInVersion: null,
      });
      expect(await blockers(pull.path)).toEqual(["must_fix_findings"]);
    });

    it("keeps a finding open that is still there, on its new lines", async () => {
      const { pull, run } = await reviewed();
      await review(run.id, scripted([[MUST_FIX], "end"]).model);
      const [finding] = (await findingsOf(pull.path)).findings;
      const tip = await push("feature");
      const [, second] = await runsOf(pull.id);
      await review(
        second!.id,
        scripted([
          [
            {
              name: "recheck_finding",
              input: {
                finding_id: finding!["id"],
                verdict: "still_present",
                start_line: 20,
                end_line: 22,
              },
            },
            // Somebody else's finding is not this reviewer's to settle.
            { name: "recheck_finding", input: { finding_id: "nope", verdict: "fixed" } },
          ],
          "end",
        ]).model,
      );
      expect((await findingsOf(pull.path)).findings[0]).toMatchObject({
        status: "open",
        startLine: 20,
        endLine: 22,
        commitOid: tip,
        lastSeenVersion: 2,
      });
    });

    it("does not raise again what a person dismissed", async () => {
      const { pull, run } = await reviewed();
      await review(run.id, scripted([[MUST_FIX], "end"]).model);
      const [finding] = (await findingsOf(pull.path)).findings;
      expect(
        await world.call("PUT", `${pull.path}/findings/${finding!["id"]}/dismiss`, {
          as: bob,
          body: { reason: "The logger strips headers" },
        }),
      ).toMatchObject({
        status: 200,
        body: { status: "dismissed", dismissalReason: "The logger strips headers" },
      });
      expect(await blockers(pull.path)).toEqual([]);

      await push("feature");
      const [, second] = await runsOf(pull.id);
      const script = scripted([[{ name: "list_findings", input: {} }], [MUST_FIX], "end"]);
      await review(second!.id, script.model);
      const results = script.toolResults();
      expect(results[0]).toContain("dismissed by a person: The logger strips headers");
      expect(results[1]).toContain("stays dismissed");
      const after = await findingsOf(pull.path);
      expect(after.findings).toHaveLength(1);
      expect(after.findings[0]).toMatchObject({
        status: "dismissed",
        lastSeenVersion: 1,
        dismissedBy: { username: bob.username },
      });
      expect(after.tally).toMatchObject({ dismissed: 1, open: 0, mustFixOpen: 0 });
      expect(await blockers(pull.path)).toEqual([]);
      // Reopened by a person, it is found again.
      expect(
        (await world.call("PUT", `${pull.path}/findings/${finding!["id"]}/reopen`, { as: bob }))
          .body,
      ).toMatchObject({ status: "open", dismissedBy: null, dismissalReason: null });
      expect(await blockers(pull.path)).toEqual(["must_fix_findings"]);
    });

    it("reads the author's trace and the checks, and no check log for a failed Terraform run", async () => {
      const { pull, run } = await reviewed();
      const [version] = await db
        .select()
        .from(gitBranchVersions)
        .where(
          and(eq(gitBranchVersions.repositoryId, id), eq(gitBranchVersions.branch, "feature")),
        );
      await db.insert(gitTraceEntries).values({
        id: newId(),
        repositoryId: id,
        branch: "feature",
        versionId: version!.id,
        kind: "evidence",
        body: "Ran the tests: all green",
        evidence: { command: "pnpm test", exitCode: 0, output: "12 passed" },
      });
      await world.call("POST", `${repo}/statuses/${version!.tipOid}`, {
        as: alice,
        body: { context: "ci/test", state: "failure", description: "3 tests failed" },
      });
      const script = scripted([
        [
          { name: "read_trace", input: {} },
          { name: "read_checks", input: {} },
          { name: "read_terraform_plan", input: {} },
          { name: "list_directory", input: { path: "" } },
          { name: "no_such_tool", input: {} },
        ],
        "end",
      ]);
      expect(await review(run.id, script.model)).toBe("done");
      const results = script.toolResults();
      expect(results[0]).toContain("[evidence] Ran the tests: all green");
      expect(results[0]).toContain("says it ran: pnpm test");
      expect(results[1]).toContain("ci/test: failure (3 tests failed)");
      expect(results[2]).toBe("No Terraform plan has been made for this pull request.");
      expect(results[4]).toContain("no tool called no_such_tool");
      expect(JSON.stringify(script.requests[0]!.messages[0])).toContain("recorded a trace");
    });

    it("is skipped, with the reason, when the organisation is at its AI spend cap", async () => {
      const { pull, run } = await reviewed();
      await db
        .update(organizations)
        .set({ chatMonthlyCapMicros: 1 })
        .where(eq(organizations.id, organization.id));
      const script = scripted([[MUST_FIX], "end"]);
      expect(await review(run.id, script.model)).toBe("failed");
      expect(script.requests).toEqual([]);
      const [row] = await runsOf(pull.id);
      expect(row).toMatchObject({ status: "failed", error: SPEND_CAP_REACHED, costMicros: 0 });
      expect(row!.finishedAt).not.toBeNull();
      expect((await findingsOf(pull.path)).findings).toEqual([]);
    });

    it("fails with what happened when the model cannot be asked, and keeps what was found before", async () => {
      const { pull, run } = await reviewed("feature", ["general", "security"]);
      const script = scripted([
        [MUST_FIX],
        // The general reviewer's second turn fails; the security reviewer declines.
        new Error("upstream said: here is your whole prompt back"),
        "refuse",
      ]);
      expect(await review(run.id, script.model)).toBe("failed");
      const [row] = await runsOf(pull.id);
      expect(row!.status).toBe("failed");
      expect(row!.error).toBe(
        "The general reviewer failed: the model call failed. The security reviewer failed: the model declined to review this change.",
      );
      // Nothing of the failure's own words is kept.
      expect(row!.error).not.toContain("prompt");
      // What was recorded before it failed stands, and what was spent is on the run.
      expect((await findingsOf(pull.path)).findings).toHaveLength(1);
      expect(row!.inputTokens).toBe(3000);
      expect(row!.finishedAt).not.toBeNull();
    });

    it("stops at its limit of steps and says so", async () => {
      const { pull, run } = await reviewed();
      const reading: Turn = [{ name: "read_diff", input: { scope: "step" } }];
      const script = scripted([reading, reading, reading, reading]);
      expect(
        await review(run.id, script.model, { limits: { ...REVIEW_LIMITS, maxTurns: 3 } }),
      ).toBe("done");
      expect(script.requests).toHaveLength(3);
      // Told before its last step.
      expect(JSON.stringify(script.requests[2]!.messages.at(-1))).toContain("one step left");
      expect((await runsOf(pull.id))[0]).toMatchObject({
        status: "done",
        error: "The general reviewer stopped early: it reached its limit of steps.",
      });
    });

    it("runs once however often its message is delivered, and is taken over only after the lease", async () => {
      const { pull, run } = await reviewed();
      const script = scripted([[MUST_FIX], "end"]);
      expect(await review(run.id, script.model)).toBe("done");
      expect(await review(run.id, script.model)).toBe("ignored");
      expect(script.requests).toHaveLength(2);
      expect((await findingsOf(pull.path)).findings).toHaveLength(1);

      // A run somebody holds is left alone inside the lease, and taken over after it.
      await push("feature");
      const [, second] = await runsOf(pull.id);
      const startedAt = Date.now();
      await db
        .update(gitReviewRuns)
        .set({ status: "running", startedAt: new Date(startedAt) })
        .where(eq(gitReviewRuns.id, second!.id));
      const takeover = scripted(["end"]);
      expect(await review(second!.id, takeover.model)).toBe("busy");
      expect(takeover.requests).toEqual([]);
      expect(
        await review(second!.id, takeover.model, {
          now: () => startedAt + REVIEW_LIMITS.leaseMs + 1000,
        }),
      ).toBe("done");
      expect(takeover.requests).toHaveLength(1);

      // A delivery past its tries fails the run instead of trying again.
      await push("feature");
      const [, , third] = await runsOf(pull.id);
      expect(
        await review(third!.id, takeover.model, { attempt: REVIEW_LIMITS.maxAttempts + 1 }),
      ).toBe("failed");
      expect((await runsOf(pull.id))[2]).toMatchObject({
        status: "failed",
        error: "The review did not finish after several tries",
      });
    });

    it("is skipped when a newer version arrived or review agents were turned off", async () => {
      const { pull, run } = await reviewed();
      await db.update(gitReviewRuns).set({ trigger: "manual" }).where(eq(gitReviewRuns.id, run.id));
      await push("feature");
      const script = scripted([[MUST_FIX], "end"]);
      expect(await review(run.id, script.model)).toBe("failed");
      const [first, second] = await runsOf(pull.id);
      expect(first!.error).toBe("Skipped: version 2 was pushed before this review started");

      await world.call("PATCH", `${repo}/review-settings`, {
        as: alice,
        body: { reviewAgentsEnabled: false },
      });
      expect(await review(second!.id, script.model)).toBe("failed");
      expect((await runsOf(pull.id))[1]!.error).toBe(
        "Skipped: review agents are off for this repository",
      );
      expect(script.requests).toEqual([]);
    });

    it("leaves no run waiting or running for ever", async () => {
      const { pull, run } = await reviewed();
      const now = new Date();
      const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
      // Queued a few minutes ago: sent again (nowhere, here), not failed.
      await db
        .update(gitReviewRuns)
        .set({ createdAt: hoursAgo(0.2) })
        .where(eq(gitReviewRuns.id, run.id));
      const sent: unknown[] = [];
      const queue = { send: async (message: unknown) => void sent.push(message) };
      await sweepReviewRuns({ REVIEWS: queue as never }, { now });
      expect(sent).toContainEqual({ type: "review", runId: run.id });
      expect((await runsOf(pull.id))[0]!.status).toBe("queued");

      await db
        .update(gitReviewRuns)
        .set({ createdAt: hoursAgo(5) })
        .where(eq(gitReviewRuns.id, run.id));
      await sweepReviewRuns({}, { now });
      expect((await runsOf(pull.id))[0]).toMatchObject({
        status: "failed",
        error: "The review was never started",
      });

      await db
        .update(gitReviewRuns)
        .set({ status: "running", startedAt: hoursAgo(1), finishedAt: null, error: null })
        .where(eq(gitReviewRuns.id, run.id));
      await sweepReviewRuns({}, { now });
      expect((await runsOf(pull.id))[0]).toMatchObject({
        status: "failed",
        error: "The review stopped without finishing",
      });
    });
  });

  describe("the findings endpoints", () => {
    it("lets an administrator merge past must-fix findings, and only the ones they saw", async () => {
      const { pull, run } = await reviewed();
      await review(run.id, scripted([[MUST_FIX], "end"]).model);
      const [finding] = (await findingsOf(pull.path)).findings;
      expect(await blockers(pull.path)).toEqual(["must_fix_findings"]);

      // Write access is not enough, and a reason is needed.
      expect(
        (
          await world.call("POST", `${pull.path}/findings/override`, {
            as: bob,
            body: { reason: "Ship it" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await world.call("POST", `${pull.path}/findings/override`, {
            as: alice,
            body: { reason: "Known and tracked", findingIds: ["not-a-finding"] },
          })
        ).status,
      ).toBe(422);
      const override = await world.call("POST", `${pull.path}/findings/override`, {
        as: alice,
        body: { reason: "Known and tracked in #12" },
      });
      expect(override).toMatchObject({
        status: 200,
        body: {
          reason: "Known and tracked in #12",
          findingIds: [finding!["id"]],
          by: { username: alice.username },
        },
      });
      expect(await blockers(pull.path)).toEqual([]);
      expect((await findingsOf(pull.path)).findings[0]).toMatchObject({
        status: "open",
        overridden: true,
      });
      expect((await findingsOf(pull.path)).tally).toMatchObject({ open: 1, mustFixOpen: 0 });
      // Nothing is left to override.
      expect(
        (
          await world.call("POST", `${pull.path}/findings/override`, {
            as: alice,
            body: { reason: "Again" },
          })
        ).status,
      ).toBe(422);

      // A finding raised afterwards is not covered.
      await push("feature");
      const [, second] = await runsOf(pull.id);
      await review(
        second!.id,
        scripted([
          [{ ...MUST_FIX, input: { ...MUST_FIX.input, title: "Migration drops a column in use" } }],
          "end",
        ]).model,
      );
      expect(await blockers(pull.path)).toEqual(["must_fix_findings"]);
      expect((await findingsOf(pull.path)).tally).toMatchObject({ open: 2, mustFixOpen: 1 });
      await world.call("POST", `${pull.path}/findings/override`, {
        as: alice,
        body: { reason: "Column is unused since #9" },
      });
      expect(
        (await world.call("POST", `${pull.path}/merge`, { as: alice, body: { method: "merge" } }))
          .status,
      ).toBe(200);
    });

    it("takes a reviewer's report from outside the forge, and never as one of the forge's own", async () => {
      await push("feature");
      const pull = await pullOf("feature");
      const report = (
        body: Record<string, unknown>,
        options: Record<string, unknown> = { as: bob },
      ) => world.call("POST", `${pull.path}/findings`, { ...options, body });
      const finding = {
        severity: "must_fix",
        title: "License header missing",
        path: "src/new.ts",
        startLine: 1,
        evidence: [{ kind: "command", text: "license-check src/new.ts\nTOKEN=abcdefgh1234" }],
      };
      // Reading is not reporting, a read-only token writes nothing, and the forge's names are its own.
      expect(
        (await report({ reviewerKind: "licenses", findings: [finding] }, { as: carol })).status,
      ).toBe(403);
      expect(
        (
          await report(
            { reviewerKind: "licenses", findings: [finding] },
            { as: bob, scopes: ["repo:read"] },
          )
        ).status,
      ).toBe(403);
      expect(
        await report({ reviewerKind: "security", findings: [finding], complete: true }),
      ).toMatchObject({ status: 422, body: { error: expect.stringContaining("forge's own") } });
      expect((await report({ reviewerKind: "licenses", version: 9, findings: [] })).status).toBe(
        422,
      );

      const first = await report(
        {
          reviewerKind: "licenses",
          findings: [finding, { severity: "note", title: "Two files share a header" }],
        },
        { as: bob, scopes: ["repo:write"] },
      );
      expect(first.status).toBe(200);
      expect(first.body.findings).toHaveLength(2);
      expect(first.body.findings[0]).toMatchObject({
        reviewerKind: "licenses",
        status: "open",
        version: 1,
        startLine: 1,
        endLine: 1,
        runId: null,
      });
      expect(first.body.findings[0].evidence[0].text).toBe("license-check src/new.ts\nTOKEN=***");
      expect(await blockers(pull.path)).toContain("must_fix_findings");

      // The same finding again is the same row; with `complete`, what is not listed is fixed.
      await push("feature");
      const second = await report({
        reviewerKind: "licenses",
        findings: [{ ...finding, startLine: 3 }],
        complete: true,
      });
      expect(second.body.findings[0]).toMatchObject({
        id: first.body.findings[0].id,
        startLine: 3,
        version: 1,
        lastSeenVersion: 2,
      });
      const all = (await findingsOf(pull.path)).findings;
      expect(all.map((row) => [row["title"], row["status"], row["fixedInVersion"]])).toEqual([
        ["Two files share a header", "fixed", 2],
        ["License header missing", "open", null],
      ]);

      // Dismissed by someone who triages, it stays dismissed when reported again.
      expect(
        (
          await world.call("PUT", `${pull.path}/findings/${all[1]!["id"]}/dismiss`, {
            as: carol,
            body: { reason: "No" },
          })
        ).status,
      ).toBe(403);
      await world.call("PUT", `${pull.path}/findings/${all[1]!["id"]}/dismiss`, {
        as: bob,
        body: { reason: "Generated file" },
      });
      expect(
        (
          await world.call("PUT", `${pull.path}/findings/${all[1]!["id"]}/dismiss`, {
            as: bob,
            body: { reason: "Twice" },
          })
        ).status,
      ).toBe(422);
      const third = await report({ reviewerKind: "licenses", findings: [finding], complete: true });
      expect(third.body.findings[0]).toMatchObject({ status: "dismissed", startLine: 3 });
      expect(await blockers(pull.path)).not.toContain("must_fix_findings");
      // Another pull request's finding is not found here.
      expect(
        (await world.call("PUT", `${pull.path}/findings/${newId()}/reopen`, { as: bob })).status,
      ).toBe(404);
    });

    it("queues a run somebody asks for, once, and keeps a reviewer's own run for it to report on", async () => {
      await push("feature");
      const pull = await pullOf("feature");
      const request = (body: Record<string, unknown> = {}, as: Person = bob) =>
        world.call("POST", `${pull.path}/review-runs`, { as, body });
      // Off for the repository: nothing of the forge's to run.
      expect(await request()).toMatchObject({
        status: 422,
        body: { error: expect.stringContaining("off for this repository") },
      });
      await enable();
      expect((await request({}, carol)).status).toBe(403);
      expect((await request({ reviewerKinds: ["general", "licenses"] })).status).toBe(422);

      const queued = await request();
      expect(queued).toMatchObject({
        status: 200,
        body: {
          status: "queued",
          trigger: "manual",
          version: 1,
          reviewerKinds: ["general"],
          requestedBy: { username: bob.username },
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          findingCount: 0,
        },
      });
      expect((await request()).status).toBe(409);
      // The forge reports on its own run.
      expect(
        (
          await world.call("PATCH", `${pull.path}/review-runs/${queued.body.id}`, {
            as: bob,
            body: { status: "done" },
          })
        ).status,
      ).toBe(422);
      expect(await review(queued.body.id, scripted(["end"]).model)).toBe("done");

      // A reviewer of somebody's own: the row is theirs to move.
      const own = await request({ reviewerKinds: ["licenses"] });
      expect(own).toMatchObject({ status: 200, body: { reviewerKinds: ["licenses"] } });
      expect(await review(own.body.id, scripted([]).model)).toBe("ignored");
      const reported = await world.call("POST", `${pull.path}/findings`, {
        as: bob,
        body: {
          reviewerKind: "licenses",
          runId: own.body.id,
          findings: [{ severity: "note", title: "Header year is stale" }],
        },
      });
      expect(reported.body.findings[0]).toMatchObject({ runId: own.body.id });
      const ended = await world.call("PATCH", `${pull.path}/review-runs/${own.body.id}`, {
        as: bob,
        body: {
          status: "done",
          model: "their-model",
          inputTokens: 1200,
          outputTokens: 80,
          costUsd: 0.02,
        },
      });
      expect(ended).toMatchObject({
        status: 200,
        body: {
          status: "done",
          model: "their-model",
          findingCount: 1,
          usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.02 },
        },
      });
      expect(ended.body.finishedAt).not.toBeNull();
      const listed = (await world.call("GET", `${pull.path}/review-runs`, { as: carol })).body.runs;
      // Newest first.
      expect(listed.map((row: any) => row.id)).toEqual([own.body.id, queued.body.id]);
      expect(
        (await world.call("GET", `${pull.path}/review-runs/${newId()}`, { as: carol })).status,
      ).toBe(404);
    });
  });

  describe("billing", () => {
    it("sends what a review used to the AI meter from the app's pass, once", async () => {
      // An organisation that pays: a Stripe customer, and not complimentary.
      const paying = await world.organization("paying", { members: [[alice, "owner"]] });
      await db.insert(subscriptions).values({
        id: newId(),
        organizationId: paying.id,
        stripeCustomerId: "cus_test_review",
        status: "active",
      });
      const row = (organizationId: string, workflowId: string) => ({
        id: newId(),
        organizationId,
        workflowId,
        runId: null,
        model: "claude-opus-5-5",
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicros: 9000,
      });
      const billed = row(paying.id, reviewUsageSource("some-repository"));
      const complimentary = row(organization.id, reviewUsageSource("another"));
      const aWorkflows = row(paying.id, "a-workflow");
      await db.insert(workflowAiUsage).values([billed, complimentary, aWorkflows]);

      vi.stubEnv("STRIPE_SECRET_KEY", "test-stripe-key");
      vi.stubEnv("INFRAWRENCH_STRIPE_CHAT_METER_EVENT", "ai_spend_micros");
      const sent: URLSearchParams[] = [];
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        expect(String(input)).toBe("https://api.stripe.com/v1/billing/meter_events");
        sent.push(new URLSearchParams(String(init?.body)));
        return new Response("{}", { status: 200 });
      });
      try {
        await reportGitReviewUsage(1000);
        await reportGitReviewUsage(1000);
      } finally {
        fetchMock.mockRestore();
        vi.stubEnv("STRIPE_SECRET_KEY", "");
        vi.stubEnv("INFRAWRENCH_STRIPE_CHAT_METER_EVENT", "");
      }
      const mine = sent.filter((body) => body.get("identifier") === billed.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.get("event_name")).toBe("ai_spend_micros");
      expect(mine[0]!.get("payload[stripe_customer_id]")).toBe("cus_test_review");
      expect(Number(mine[0]!.get("payload[value]"))).toBe(9000);
      expect(sent.some((body) => body.get("identifier") === complimentary.id)).toBe(false);
      const settled = async (usageId: string) =>
        (
          await db
            .select({ as: workflowAiUsage.stripeUsageRecordId })
            .from(workflowAiUsage)
            .where(eq(workflowAiUsage.id, usageId))
        )[0]!.as;
      expect(await settled(billed.id)).toBe(billed.id);
      expect(await settled(complimentary.id)).toBe(GIT_REVIEW_NOT_BILLED);
      // A workflow's own usage is not this pass's to send.
      expect(await settled(aWorkflows.id)).toBeNull();
    });
  });

  it("keeps findings out of reach of anyone who cannot read the repository", async () => {
    const hidden = await world.repository(alice, organization.slug, `hidden-${count}`, "private");
    await push("feature", { in: hidden.id });
    const pull = await pullOf("feature", hidden.path);
    await db.insert(gitReviewFindings).values({
      id: newId(),
      repositoryId: hidden.id,
      pullRequestId: pull.id,
      versionNumber: 1,
      lastSeenVersionNumber: 1,
      reviewerKind: "general",
      fingerprint: "general:secret",
      commitOid: ZERO,
      severity: "note",
      title: "Internal detail",
    });
    expect((await world.call("GET", `${pull.path}/findings`, { as: alice })).status).toBe(200);
    for (const path of ["findings", "review-runs"]) {
      expect((await world.call("GET", `${pull.path}/${path}`, { as: carol })).status).toBe(404);
      expect((await world.call("GET", `${pull.path}/${path}`)).status).toBe(404);
    }
  });
});
