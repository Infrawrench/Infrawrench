/**
 * Traces against a real Postgres: who may record and where, what reaches
 * the table (masked, cut, bounded), the push that claims what waited, and
 * what a reader is shown.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ciRuns, gitTraceEntries } from "@infrawrench/server-core/db/schema";
import type { Principal } from "../../auth/principal";
import { db, newId } from "../../db/client";
import type { GitPushEvent } from "../../env";
import { handlePush } from "../../events/consumer";
import { pruneStaleTraces } from "../../review/prune";
import { TRACE_LIMITS } from "../../review/trace";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ZERO = "0".repeat(40);
/** Assembled here so no line of this file is a token's shape. */
const fakeToken = `iwg_${"aB3dE6gH9jK2mN5pQ8rS1tU4vW7xY0z".repeat(2).slice(0, 43)}`;

describe.skipIf(!configured)("traces, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person;
  let organization: { id: string; slug: string };
  let repo: string;
  let id: string;
  let count = 0;

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob, carol] = (await Promise.all(
      ["alice", "bob", "carol"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
    organization = await world.organization("acme", {
      paid: true,
      git: true,
      members: [[alice, "owner"]],
    });
  });
  afterAll(() => world?.cleanup());
  beforeEach(async () => {
    const made = await world.repository(alice, organization.slug, `traces-${++count}`, "private");
    repo = made.path;
    id = made.id;
    await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });
    await world.call("PUT", `${repo}/collaborators/${carol.username}`, {
      as: alice,
      body: { role: "read" },
    });
  });

  const push = async (branch: string, at = Date.now()) => {
    const newOid = world.storage.nextOid();
    world.storage.commits.set(newOid, { message: "A change", email: alice.email });
    const oldOid = world.storage.moveBranch(id, branch, newOid, { forced: false, at }) ?? ZERO;
    const event: GitPushEvent = {
      type: "push",
      repoId: id,
      actor: { kind: "user", userId: alice.id, credentialId: null },
      updates: [{ name: `refs/heads/${branch}`, oldOid, newOid, forced: false }],
      at,
    };
    await handlePush(event, world.env, world.storage.readers);
    await handlePush(event, world.env, world.storage.readers);
  };

  const record = (
    body: Record<string, unknown>,
    options: Parameters<World["call"]>[2] = { as: bob },
  ) => world.call("POST", `${repo}/traces`, { ...options, body });
  const entry = (text: string, kind = "step") => ({ kind, body: text });
  const stored = () =>
    db
      .select()
      .from(gitTraceEntries)
      .where(eq(gitTraceEntries.repositoryId, id))
      .orderBy(gitTraceEntries.createdAt);

  const job = (runId: string | null, repositoryId = id): Principal => ({
    kind: "job",
    repositoryId,
    write: false,
    runId,
    workspaceId: null,
  });
  /** A CI run of this repository, as the app's dispatcher records one. */
  const ciRun = async (headRef: string, options: { fromFork?: boolean } = {}) => {
    const runId = newId();
    await db.insert(ciRuns).values({
      id: runId,
      organizationId: organization.id,
      installationId: 0,
      gitRepositoryId: id,
      repoFullName: `${organization.slug}/traces-${count}`,
      ownerKey: `git.infrawrench.com-${organization.slug}`,
      repoKey: `traces-${count}`,
      event: options.fromFork ? "pull_request" : "push",
      branch: options.fromFork ? "pull/1" : headRef,
      headRef,
      defaultBranch: "main",
      sha: "a".repeat(40),
      fromFork: options.fromFork ?? false,
      status: "pending",
      dedupeKey: runId,
    } as typeof ciRuns.$inferInsert);
    return runId;
  };

  it("records in order, as the person, and answers what it stored", async () => {
    const answer = await record({
      branch: "feature",
      agent: { kind: "mcp", name: "Claude Code", sessionRef: "session-1" },
      entries: [
        entry("Add rate limits to the API", "ask"),
        entry("Read `http/rate-limit.ts`"),
        {
          kind: "decision",
          body: "Count by principal, not by address",
          anchors: [{ path: "src/http/admission.ts", startLine: 40, endLine: 12 }],
        },
        {
          kind: "evidence",
          body: "The suite passes",
          evidence: { command: "pnpm test", exitCode: 0, output: "42 passed" },
        },
        entry("Not sure the window is right for CI", "doubt"),
      ],
    });
    expect(answer.status).toBe(200);
    expect(answer.body.entries.map((e: any) => e.kind)).toEqual([
      "ask",
      "step",
      "decision",
      "evidence",
      "doubt",
    ]);
    expect(answer.body.entries[0]).toMatchObject({
      branch: "feature",
      version: null,
      author: { username: bob.username },
      agent: { kind: "mcp", name: "Claude Code", sessionRef: "session-1" },
      evidence: null,
      anchors: [],
    });
    // A range that ends before it starts is one line.
    expect(answer.body.entries[2].anchors).toEqual([
      { path: "src/http/admission.ts", startLine: 40, endLine: 40 },
    ]);
    expect(answer.body.entries[3].evidence).toEqual({
      command: "pnpm test",
      exitCode: 0,
      output: "42 passed",
      ciRunId: null,
      url: null,
    });

    const listed = await world.call("GET", `${repo}/traces?branch=feature`, { as: carol });
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((e: any) => e.id)).toEqual(
      answer.body.entries.map((e: any) => e.id),
    );
    expect(listed.body.nextCursor).toBeNull();
  });

  it("stores nothing unmasked", async () => {
    const answer = await record({
      branch: "feature",
      agent: { kind: "mcp", name: `agent ${fakeToken}` },
      entries: [
        {
          kind: "evidence",
          body: `Called the API with ${fakeToken}`,
          anchors: [{ path: `notes/${fakeToken}.md` }],
          evidence: {
            command: `curl -H 'Authorization: Bearer ${fakeToken}' https://example.test`,
            output: `DATABASE_PASSWORD=hunter2\nok ${fakeToken}`,
            url: `https://deploy:hunter2@example.test/run`,
          },
        },
      ],
    });
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).not.toContain(fakeToken);
    const text = JSON.stringify(await stored());
    expect(text).not.toContain(fakeToken);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("DATABASE_PASSWORD=***");
  });

  it("cuts a long excerpt and refuses a long body", async () => {
    const output = `first line\n${"x".repeat(60_000)}\nFAILED at the end`;
    const cut = await record({
      branch: "feature",
      entries: [{ kind: "evidence", body: "It fails", evidence: { output } }],
    });
    expect(cut.status).toBe(200);
    const kept: string = cut.body.entries[0].evidence.output;
    expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(TRACE_LIMITS.outputBytes);
    expect(kept.startsWith("first line\n")).toBe(true);
    expect(kept.endsWith("FAILED at the end")).toBe(true);
    expect(kept).toMatch(/\[\.\.\. \d+ bytes left out \.\.\.\]/);

    const refused = await record({
      branch: "feature",
      entries: [entry("ok"), entry("é".repeat(TRACE_LIMITS.bodyBytes / 2 + 1))],
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "too_large" });
    expect(refused.body.error).toContain("Entry 2");
    // Nothing of a refused call is stored, the entry before the long one included.
    expect(await stored()).toHaveLength(1);
  });

  it("takes write access, whatever the credential", async () => {
    const body = { branch: "feature", entries: [entry("a step")] };
    // A reader, and a visitor who cannot see the repository at all.
    expect((await record(body, { as: carol })).status).toBe(403);
    const stranger = await world.person("stranger");
    expect((await record(body, { as: stranger })).status).toBe(404);
    expect((await record(body, {})).status).toBe(404);
    // A token without `repo:write` reads only; one with it writes.
    expect((await record(body, { as: bob, scopes: ["repo:read"] })).status).toBe(403);
    expect((await record(body, { as: bob, scopes: ["repo:read", "repo:write"] })).status).toBe(200);
    // A deploy key pushes; it does not speak for an agent.
    const deployKey: Principal = {
      kind: "deploy-key",
      keyId: "key-1",
      repositoryId: id,
      readOnly: false,
    };
    expect((await record(body, { principal: deployKey })).status).toBe(403);
    expect(await stored()).toHaveLength(1);
  });

  it("takes a CI job's token for its run's branch and nothing else", async () => {
    const runId = await ciRun("feature");
    const body = (branch: string) => ({ branch, entries: [entry("ran in CI", "evidence")] });

    const ok = await record(body("feature"), { principal: job(runId) });
    expect(ok.status).toBe(200);
    expect(ok.body.entries[0]).toMatchObject({ author: null, branch: "feature" });

    // Another branch, a run that is not this repository's, no run at all.
    expect((await record(body("other"), { principal: job(runId) })).status).toBe(403);
    expect((await record(body("feature"), { principal: job(newId()) })).status).toBe(403);
    expect((await record(body("feature"), { principal: job(null) })).status).toBe(403);
    // A fork's pull request is not trusted with the base repository's record.
    const forkRun = await ciRun("feature", { fromFork: true });
    expect((await record(body("feature"), { principal: job(forkRun) })).status).toBe(403);
    // A token for another repository cannot see this one.
    expect(
      (await record(body("feature"), { principal: job(runId, "another-repository") })).status,
    ).toBe(404);
    // And a job reads no trace: only `record` is its.
    expect(await stored()).toHaveLength(1);
  });

  it("refuses the default branch and what is not a branch", async () => {
    for (const branch of ["main", "a..b", "refs/tags/v1", "has space", "/lead", "x.lock"]) {
      const answer = await record({ branch, entries: [entry("a step")] });
      expect([branch, answer.status]).toEqual([branch, 422]);
    }
    // The long form of a branch's name is the branch.
    const long = await record({ branch: "refs/heads/feature", entries: [entry("a step")] });
    expect(long.body.entries[0].branch).toBe("feature");
  });

  it("bounds what waits on a branch", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => entry(`step ${i}`));
    for (let call = 0; call < TRACE_LIMITS.pendingPerBranch / 100; call++) {
      expect((await record({ branch: "busy", entries: hundred })).status).toBe(200);
    }
    const full = await record({ branch: "busy", entries: [entry("one more")] });
    expect(full.status).toBe(422);
    expect(full.body.error).toContain("push");
    // Another branch still has room, and a push makes room on this one.
    expect((await record({ branch: "quiet", entries: [entry("a step")] })).status).toBe(200);
    await push("busy");
    expect((await record({ branch: "busy", entries: [entry("after the push")] })).status).toBe(200);
  });

  it("gives what waited to the version the next push makes", async () => {
    await record({ branch: "feature", entries: [entry("the ask", "ask"), entry("first step")] });
    await push("feature");
    await record({ branch: "feature", entries: [entry("second step")] });

    const [pull] = (await world.call("GET", `${repo}/pulls?state=all&head=feature`, { as: alice }))
      .body.items;
    const all = await world.call("GET", `${repo}/traces?pull=${pull.number}`, { as: carol });
    expect(all.body.items.map((e: any) => [e.body, e.version])).toEqual([
      ["the ask", 1],
      ["first step", 1],
      ["second step", null],
    ]);
    const one = await world.call("GET", `${repo}/traces?pull=${pull.number}&version=1`, {
      as: carol,
    });
    expect(one.body.items.map((e: any) => e.body)).toEqual(["the ask", "first step"]);
    const waiting = await world.call("GET", `${repo}/traces?branch=feature&version=pending`, {
      as: carol,
    });
    expect(waiting.body.items.map((e: any) => e.body)).toEqual(["second step"]);

    await push("feature");
    const two = await world.call("GET", `${repo}/traces?branch=feature&version=2`, { as: carol });
    expect(two.body.items.map((e: any) => e.body)).toEqual(["second step"]);
    expect(
      (await world.call("GET", `${repo}/traces?branch=feature&version=3`, { as: carol })).status,
    ).toBe(404);
    const versions = await world.call("GET", `${repo}/pulls/${pull.number}/versions`, {
      as: carol,
    });
    expect(versions.body.versions.map((v: any) => v.counts.traceEntries)).toEqual([2, 1]);
  });

  it("pages oldest first", async () => {
    await record({
      branch: "feature",
      entries: Array.from({ length: 7 }, (_, i) => entry(`step ${i}`)),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await world.call(
        "GET",
        `${repo}/traces?branch=feature&limit=3${cursor ? `&cursor=${cursor}` : ""}`,
        { as: carol },
      );
      seen.push(...page.body.items.map((e: any) => e.body));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `step ${i}`));
  });

  it("needs one of pull and branch, and hides a private repository's trace", async () => {
    expect((await world.call("GET", `${repo}/traces`, { as: carol })).status).toBe(400);
    expect((await world.call("GET", `${repo}/traces?branch=a&pull=1`, { as: carol })).status).toBe(
      400,
    );
    expect((await world.call("GET", `${repo}/traces?pull=999`, { as: carol })).status).toBe(404);
    expect((await world.call("GET", `${repo}/traces?branch=feature`, {})).status).toBe(404);
  });

  it("drops what waited thirty days for a push", async () => {
    await record({ branch: "abandoned", entries: [entry("old"), entry("older")] });
    await record({ branch: "feature", entries: [entry("claimed")] });
    await push("feature");
    await record({ branch: "fresh", entries: [entry("new")] });
    const long = new Date(Date.now() - (TRACE_LIMITS.pendingDays + 1) * 24 * 60 * 60 * 1000);
    await db
      .update(gitTraceEntries)
      .set({ createdAt: long })
      .where(and(eq(gitTraceEntries.repositoryId, id), eq(gitTraceEntries.branch, "abandoned")));
    // A claimed entry is its version's to keep, however old.
    await db
      .update(gitTraceEntries)
      .set({ createdAt: long })
      .where(and(eq(gitTraceEntries.repositoryId, id), eq(gitTraceEntries.branch, "feature")));
    expect(await pruneStaleTraces()).toBeGreaterThanOrEqual(2);
    expect((await stored()).map((row) => row.body).sort()).toEqual(["claimed", "new"]);
  });
});
