/**
 * Instructions against a real Postgres: sending one from text, a review
 * thread and a finding; an agent marking it delivered and answered, with a
 * person's token and a job's; the version that answers it; withdrawing one;
 * and delivery, whoever queued the row.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gitInstructions, gitReviewFindings } from "@infrawrench/server-core/db/schema";
import { db, newId } from "../../db/client";
import { insertInstruction } from "../../db/instructions";
import { setAgentLink } from "../../db/review";
import type { GitPushEvent } from "../../env";
import { handlePush } from "../../events/consumer";
import {
  type InstructionSenders,
  deliverInstructions,
  sweepInstructions,
} from "../../review/instructions";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ZERO = "0".repeat(40);

describe.skipIf(!configured)("instructions, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person;
  let repo: string;
  let id: string;
  let pull: string;
  let pullRequestId: string;
  let count = 0;

  const push = async (branch: string, by: Person = alice) => {
    const at = Date.now();
    const newOid = world.storage.nextOid();
    world.storage.commits.set(newOid, { message: "A change", email: by.email });
    const oldOid = world.storage.moveBranch(id, branch, newOid, { forced: false, at }) ?? ZERO;
    const event: GitPushEvent = {
      type: "push",
      repoId: id,
      actor: { kind: "user", userId: by.id, credentialId: null },
      updates: [{ name: `refs/heads/${branch}`, oldOid, newOid, forced: false }],
      at,
    };
    await handlePush(event, world.env, world.storage.readers);
    await handlePush(event, world.env, world.storage.readers);
    return newOid;
  };

  const send = (body: Record<string, unknown>, as: Person = bob) =>
    world.call("POST", `${pull}/instructions`, { as, body });
  const text = async (words: string) => (await send({ source: "text", body: words })).body;
  const listed = async (status?: string) =>
    (
      await world.call("GET", `${pull}/instructions${status ? `?status=${status}` : ""}`, {
        as: bob,
      })
    ).body.instructions as Array<Record<string, any>>;
  const state = async () => (await world.call("GET", `${pull}/branch-state`, { as: bob })).body;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, carol] = (await Promise.all(
      ["alice", "bob", "carol"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
  });
  afterAll(() => world?.cleanup());
  beforeEach(async () => {
    const made = await world.repository(alice, alice.username, `instructions-${++count}`);
    repo = made.path;
    id = made.id;
    await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });
    world.storage.changedLines.clear();
    world.storage.lineShift = 0;
    await push("feature");
    const [page] = (await world.call("GET", `${repo}/pulls?state=all&head=feature`, { as: alice }))
      .body.items as Array<Record<string, any>>;
    pull = `${repo}/pulls/${page!["number"]}`;
    pullRequestId = page!["id"];
  });

  it("sends text, a review thread and a finding, written out as they read then", async () => {
    expect((await send({ source: "text" })).status).toBe(400);
    expect((await send({ source: "review_comment" })).status).toBe(400);
    expect((await send({ source: "finding" })).status).toBe(400);

    const plain = await send({ source: "text", body: "Use the shared limiter." });
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({
      source: "text",
      body: "Use the shared limiter.",
      status: "queued",
      reviewCommentId: null,
      findingId: null,
      deliveredVia: null,
      answeredInVersion: null,
    });
    expect(plain.body.createdBy.username).toBe(bob.username);

    const thread = (
      await world.call("POST", `${pull}/comments`, {
        as: bob,
        body: {
          body: "This loops forever",
          path: "src/a.ts",
          line: 12,
          side: "RIGHT",
          startLine: 10,
        },
      })
    ).body.thread as Record<string, any>;
    const reply = (
      await world.call("POST", `${pull}/comments`, {
        as: alice,
        body: { body: "Only when empty", inReplyTo: thread["id"] },
      })
    ).body;
    const replyId = (reply.thread?.comments ?? reply.comments ?? []).at(-1)?.id as string;
    const fromThread = await send({
      source: "review_comment",
      reviewCommentId: replyId ?? thread["id"],
      body: "Fix the empty case too.",
    });
    expect(fromThread.status).toBe(200);
    // Any comment of the thread names the thread.
    expect(fromThread.body.reviewCommentId).toBe(thread["id"]);
    expect(fromThread.body.body).toContain(
      "Review comment on `src/a.ts` lines 10-12 (written on v1):",
    );
    expect(fromThread.body.body).toContain("> This loops forever");
    expect(fromThread.body.body).toContain("> Only when empty");
    expect(fromThread.body.body.endsWith("Fix the empty case too.")).toBe(true);

    const findingId = newId();
    await db.insert(gitReviewFindings).values({
      id: findingId,
      repositoryId: id,
      pullRequestId,
      versionNumber: 1,
      lastSeenVersionNumber: 1,
      reviewerKind: "general",
      fingerprint: `f-${findingId}`,
      path: "src/b.ts",
      startLine: 4,
      endLine: 4,
      commitOid: "a".repeat(40),
      severity: "must_fix",
      title: "Token logged",
      body: "The token reaches the log line.",
    });
    expect((await state()).findings.needsPerson).toBe(1);
    const fromFinding = await send({ source: "finding", findingId });
    expect(fromFinding.body).toMatchObject({ source: "finding", findingId, status: "queued" });
    expect(fromFinding.body.body).toBe(
      "Review finding (must fix) in `src/b.ts` line 4, raised on v1: Token logged\n\nThe token reaches the log line.",
    );
    // Sent to the agent: it no longer waits on a person.
    expect((await state()).findings.needsPerson).toBe(0);

    expect((await send({ source: "finding", findingId: newId() })).status).toBe(422);
    expect((await send({ source: "review_comment", reviewCommentId: newId() })).status).toBe(422);

    expect((await listed()).map((each) => each["source"])).toEqual([
      "text",
      "review_comment",
      "finding",
    ]);
    expect(await listed("answered")).toEqual([]);
  });

  it("is sent by people who can write, and read by anyone who can read", async () => {
    const body = { source: "text", body: "Do it." };
    expect((await world.call("POST", `${pull}/instructions`, { body })).status).toBe(401);
    expect((await send(body, carol)).status).toBe(403);
    expect(
      (await world.call("POST", `${pull}/instructions`, { as: bob, scopes: ["repo:read"], body }))
        .status,
    ).toBe(403);
    expect(
      (await world.call("POST", `${pull}/instructions`, { as: bob, scopes: ["repo:write"], body }))
        .status,
    ).toBe(200);
    // A job answers instructions; it does not give them.
    expect(
      (
        await world.call("POST", `${pull}/instructions`, {
          job: { repositoryId: id, write: true },
          body,
        })
      ).status,
    ).toBe(403);
    expect((await world.call("GET", `${pull}/instructions`, { as: carol })).status).toBe(200);
    // A token bound to a branch answers for that branch's pull request only.
    const [only] = await listed();
    const bound = (ref: string) => ({ job: { repositoryId: id, write: true, ref }, body: {} });
    for (const mark of ["delivered", "answered"]) {
      expect(
        (
          await world.call(
            "PUT",
            `${pull}/instructions/${only!["id"]}/${mark}`,
            bound("refs/heads/another"),
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await world.call(
          "PUT",
          `${pull}/instructions/${only!["id"]}/delivered`,
          bound("refs/heads/feature"),
        )
      ).body,
    ).toMatchObject({ status: "delivered" });
    expect(
      (await world.call("GET", `${pull}/instructions`, { job: { repositoryId: id, write: false } }))
        .body.instructions,
    ).toHaveLength(1);
    expect(
      (await world.call("POST", `${repo}/pulls/9999/instructions`, { as: bob, body })).status,
    ).toBe(404);
  });

  it("is marked delivered and answered by its agent, and the next version says so", async () => {
    const one = await text("First.");
    const two = await text("Second.");
    const three = await text("Third.");
    expect(await state()).toMatchObject({ state: "agent_working", openInstructions: 3 });

    const token = { as: bob, scopes: ["repo:write"] as const };
    const delivered = await world.call("PUT", `${pull}/instructions/${one.id}/delivered`, {
      ...token,
      body: {},
    });
    expect(delivered.body).toMatchObject({ status: "delivered", deliveredVia: "mcp" });
    expect(delivered.body.deliveredAt).not.toBeNull();
    // Told twice is told once.
    const again = await world.call("PUT", `${pull}/instructions/${one.id}/delivered`, {
      ...token,
      body: { via: "other" },
    });
    expect(again.body).toMatchObject({ status: "delivered", deliveredVia: "mcp" });

    // A job's token for the repository does the same, when it may write.
    const job = { job: { repositoryId: id, write: true } };
    expect(
      (
        await world.call("PUT", `${pull}/instructions/${two.id}/delivered`, {
          job: { repositoryId: id, write: false },
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await world.call("PUT", `${pull}/instructions/${two.id}/delivered`, {
          job: { repositoryId: "another-repository", write: true },
          body: {},
        })
      ).status,
      // Another repository's job reads this public one like anybody, and writes nothing.
    ).toBe(403);
    expect(
      (
        await world.call("PUT", `${pull}/instructions/${two.id}/delivered`, {
          ...job,
          body: { via: "infrawrench" },
        })
      ).body,
    ).toMatchObject({ status: "delivered", deliveredVia: "infrawrench" });
    expect(
      (await world.call("PUT", `${pull}/instructions/${two.id}/dismiss`, { ...job })).status,
    ).toBe(403);
    expect(
      (
        await world.call("PUT", `${pull}/instructions/${one.id}/delivered`, {
          as: carol,
          body: {},
        })
      ).status,
    ).toBe(403);

    // No such version yet.
    expect(
      (
        await world.call("PUT", `${pull}/instructions/${one.id}/answered`, {
          ...token,
          body: { version: 2 },
        })
      ).status,
    ).toBe(422);
    // "My next push answers it": answered, by a version that is not there yet.
    const promised = await world.call("PUT", `${pull}/instructions/${one.id}/answered`, {
      ...token,
      body: {},
    });
    expect(promised.body).toMatchObject({ status: "answered", answeredInVersion: null });
    expect(await state()).toMatchObject({ state: "agent_working", openInstructions: 3 });

    await push("feature", bob);
    const [first, second] = await listed();
    expect(first).toMatchObject({ id: one.id, status: "answered", answeredInVersion: 2 });
    expect(second).toMatchObject({ id: two.id, status: "delivered", answeredInVersion: null });

    // Named outright, and never delivered: answering it is how it was delivered.
    const named = await world.call("PUT", `${pull}/instructions/${three.id}/answered`, {
      ...job,
      body: { version: 2 },
    });
    expect(named.body).toMatchObject({ status: "answered", answeredInVersion: 2 });
    expect(named.body.deliveredAt).not.toBeNull();
    const versions = (await world.call("GET", `${pull}/versions`, { as: bob })).body.versions;
    expect(versions.map((v: any) => v.counts.answeredInstructions)).toEqual([0, 2]);

    // Promised after the push: it is the next one that answers it.
    await world.call("PUT", `${pull}/instructions/${two.id}/answered`, { ...token, body: {} });
    expect((await listed())[1]).toMatchObject({ status: "answered", answeredInVersion: null });
    await push("feature", bob);
    expect((await listed())[1]).toMatchObject({ status: "answered", answeredInVersion: 3 });
    expect(await state()).toMatchObject({ openInstructions: 0 });
  });

  it("tells the review thread it came from which version answered it", async () => {
    const thread = (
      await world.call("POST", `${pull}/comments`, {
        as: bob,
        body: { body: "Rename this", path: "src/a.ts", line: 3, side: "RIGHT" },
      })
    ).body.thread as Record<string, any>;
    const sent = (await send({ source: "review_comment", reviewCommentId: thread["id"] })).body;
    await world.call("PUT", `${pull}/instructions/${sent.id}/answered`, {
      as: bob,
      scopes: ["repo:write"],
      body: {},
    });
    // The lines stand in the new version, so the push alone would not say it was answered.
    await push("feature", bob);
    const [after] = (await world.call("GET", `${pull}/threads`, { as: bob })).body.threads as Array<
      Record<string, any>
    >;
    expect(after).toMatchObject({ id: thread["id"], answeredInVersion: 2, outdated: false });
  });

  it("is withdrawn by a person until a version answers it", async () => {
    const one = await text("First.");
    const two = await text("Second.");
    const gone = await world.call("PUT", `${pull}/instructions/${one.id}/dismiss`, { as: alice });
    expect(gone.body).toMatchObject({ status: "dismissed" });
    expect(gone.body.dismissedBy.username).toBe(alice.username);
    expect(gone.body.dismissedAt).not.toBeNull();
    // Again is the same answer; an agent cannot bring it back.
    expect(
      (await world.call("PUT", `${pull}/instructions/${one.id}/dismiss`, { as: alice })).body
        .status,
    ).toBe("dismissed");
    for (const mark of ["delivered", "answered"]) {
      expect(
        (await world.call("PUT", `${pull}/instructions/${one.id}/${mark}`, { as: bob, body: {} }))
          .status,
      ).toBe(422);
    }
    expect(await state()).toMatchObject({ openInstructions: 1 });
    expect(
      (await world.call("PUT", `${pull}/instructions/${two.id}/dismiss`, { as: carol })).status,
    ).toBe(403);

    // Promised but not pushed can still go; answered by a version is on the record.
    await world.call("PUT", `${pull}/instructions/${two.id}/answered`, { as: bob, body: {} });
    const three = await text("Third.");
    await world.call("PUT", `${pull}/instructions/${three.id}/answered`, { as: bob, body: {} });
    expect(
      (await world.call("PUT", `${pull}/instructions/${two.id}/dismiss`, { as: bob })).body.status,
    ).toBe("dismissed");
    await push("feature", bob);
    expect(
      (await world.call("PUT", `${pull}/instructions/${three.id}/dismiss`, { as: bob })).status,
    ).toBe(422);
    // The withdrawn one was not answered by the push.
    expect((await listed()).map((each) => [each["status"], each["answeredInVersion"]])).toEqual([
      ["dismissed", null],
      ["dismissed", null],
      ["answered", 2],
    ]);
  });

  describe("delivery", () => {
    const link = (kind: "t3" | "mcp" | "infrawrench") =>
      setAgentLink({
        pullRequestId,
        repositoryId: id,
        kind,
        displayName: "An agent",
        externalRefs: {},
        t3EnvironmentId: null,
        connectedByUserId: bob.id,
      });
    const recorder = () => {
      const told: string[] = [];
      const senders: InstructionSenders = {
        t3: async (_env, target, instruction) => {
          expect(target.pull.pull.issueId).toBe(pullRequestId);
          expect(target.repo.repository.id).toBe(id);
          told.push(instruction.body);
        },
      };
      return { told, senders };
    };

    it("leaves instructions queued for an agent that asks for them", async () => {
      await text("No agent named.");
      const { told, senders } = recorder();
      expect(await deliverInstructions(world.env, pullRequestId, { senders })).toEqual({
        delivered: 0,
        queued: 1,
      });
      for (const kind of ["mcp", "infrawrench"] as const) {
        await link(kind);
        await deliverInstructions(world.env, pullRequestId, { senders });
      }
      expect(told).toEqual([]);
      expect((await listed()).map((each) => each["status"])).toEqual(["queued"]);
    });

    it("tells an agent the forge can reach, in order, once", async () => {
      await text("First.");
      await text("Second.");
      const withdrawn = await text("Withdrawn.");
      await world.call("PUT", `${pull}/instructions/${withdrawn.id}/dismiss`, { as: bob });
      await link("t3");
      const { told, senders } = recorder();
      // Two callers at once, as the sender and the sweep can be.
      const results = await Promise.all([
        deliverInstructions(world.env, pullRequestId, { senders }),
        deliverInstructions(world.env, pullRequestId, { senders }),
      ]);
      expect(results.reduce((sum, each) => sum + each.delivered, 0)).toBe(2);
      expect([...told].sort()).toEqual(["First.", "Second."]);
      expect((await listed()).map((each) => [each["status"], each["deliveredVia"]])).toEqual([
        ["delivered", "t3"],
        ["delivered", "t3"],
        ["dismissed", null],
      ]);
      expect(await deliverInstructions(world.env, pullRequestId, { senders })).toEqual({
        delivered: 0,
        queued: 0,
      });
    });

    it("puts back what could not be told, and stops there", async () => {
      await text("First.");
      await text("Second.");
      await link("t3");
      let attempts = 0;
      const failing: InstructionSenders = {
        t3: async () => {
          attempts++;
          throw new Error("The environment did not answer");
        },
      };
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await deliverInstructions(world.env, pullRequestId, { senders: failing })).toEqual({
        delivered: 0,
        queued: 2,
      });
      quiet.mockRestore();
      expect(attempts).toBe(1);
      expect((await listed()).map((each) => [each["status"], each["deliveredVia"]])).toEqual([
        ["queued", null],
        ["queued", null],
      ]);
    });

    it("sweeps up a row somebody else queued, once it has waited", async () => {
      await link("t3");
      // As the review runner does for a must-fix finding: its own insert, no API.
      const row = await insertInstruction({
        repositoryId: id,
        pullRequestId,
        source: "text",
        reviewCommentId: null,
        findingId: null,
        body: "Queued by another part of the forge.",
        createdByUserId: null,
      });
      const { told, senders } = recorder();
      // Just made: its maker's to deliver.
      await sweepInstructions(world.env, { senders });
      expect(told).not.toContain(row.body);
      await db
        .update(gitInstructions)
        .set({ createdAt: new Date(Date.now() - 5 * 60 * 1000) })
        .where(eq(gitInstructions.id, row.id));
      const swept = await sweepInstructions(world.env, { senders });
      expect(swept.delivered).toBeGreaterThanOrEqual(1);
      expect(told).toContain(row.body);
      expect((await listed())[0]).toMatchObject({ status: "delivered", deliveredVia: "t3" });
    });

    it("tells nobody about a pull request that is closed", async () => {
      await text("Too late.");
      await link("t3");
      expect((await world.call("POST", `${pull}/close`, { as: alice, body: {} })).status).toBe(200);
      const { told, senders } = recorder();
      await deliverInstructions(world.env, pullRequestId, { senders });
      expect(told).toEqual([]);
      expect((await send({ source: "text", body: "Later still." })).status).toBe(422);
    });
  });
});
