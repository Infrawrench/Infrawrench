/**
 * An agent's token for one branch's markers, against a real Postgres: who
 * may ask for one, what it then reaches (its branch's trace, instructions
 * and findings) and everything it does not (another branch, sending or
 * dismissing, statuses, settings, another repository, another token).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyJobToken } from "../../auth/job-token";
import type { Principal } from "../../auth/principal";
import type { GitPushEvent } from "../../env";
import { handlePush } from "../../events/consumer";
import { type Person, type World, configured, makeWorld, pagePath } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ZERO = "0".repeat(40);
const KEY = "a-job-token-key-of-at-least-thirty-two-characters";

describe.skipIf(!configured)("an agent's token, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person, carol: Person;
  let organization: { id: string; slug: string };
  let repo: string;
  let id: string;
  let other: { path: string; id: string };
  let count = 0;

  beforeAll(async () => {
    world = makeWorld();
    Object.assign(world.env, { GIT_JOB_TOKEN_KEY: KEY });
    [alice, bob, carol] = (await Promise.all(
      ["alice", "bob", "carol"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
    organization = await world.organization("acme", { paid: true, members: [[alice, "owner"]] });
  });
  afterAll(() => world?.cleanup());
  beforeEach(async () => {
    const made = await world.repository(alice, organization.slug, `agent-${++count}`, "private");
    repo = made.path;
    id = made.id;
    other = await world.repository(alice, organization.slug, `agent-other-${count}`, "private");
    await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });
    await world.call("PUT", `${repo}/collaborators/${carol.username}`, {
      as: alice,
      body: { role: "read" },
    });
    await push("work/a");
    await push("work/b");
  });

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
  };

  const page = (branch: string, of = repo) => pagePath(of, branch);
  const ask = (branch: string, options: Parameters<World["call"]>[2] = { as: bob }) =>
    world.call("POST", `${page(branch)}/agent/token`, options);

  /** The principal the Worker makes of a token where agents' tokens are taken. */
  const agentOf = async (token: string): Promise<{ principal: Principal }> => {
    const claims = await verifyJobToken(KEY, token, undefined, { agent: true });
    if (!claims) throw new Error("The token did not verify");
    return {
      principal: {
        kind: "job",
        repositoryId: claims.repositoryId,
        write: claims.write,
        runId: claims.runId,
        workspaceId: claims.workspaceId,
        ref: claims.ref,
        agentRef: claims.agentRef,
      },
    };
  };

  it("is given to whoever can write the branch, and to nobody else", async () => {
    const given = await ask("work/a");
    expect(given.status).toBe(200);
    expect(given.body).toMatchObject({ branch: "work/a" });
    expect(given.body.token).toMatch(/^iwj_/);
    const lasts = Date.parse(given.body.expiresAt) - Date.now();
    expect(lasts).toBeGreaterThan(5.9 * 3600_000);
    expect(lasts).toBeLessThanOrEqual(6 * 3600_000);

    // The token is for this repository and this branch's markers: no push, no workspace.
    const claims = await verifyJobToken(KEY, given.body.token, undefined, { agent: true });
    expect(claims).toMatchObject({
      repositoryId: id,
      agentRef: "refs/heads/work/a",
      ref: null,
      workspaceId: null,
      runId: `agent:${bob.id}`,
    });
    // Nothing that serves Git, an archive or a workspace takes it.
    for (const expect_ of [{}, { ref: true }, { workspace: true }, { commit: "c".repeat(40) }]) {
      expect(await verifyJobToken(KEY, given.body.token, undefined, expect_)).toBeNull();
    }

    // A personal access token that can write gets one: that is how a thread asks.
    expect((await ask("work/a", { as: bob, scopes: ["repo:write"] })).status).toBe(200);
    expect((await ask("work/a", { as: bob, scopes: ["repo:read"] })).status).toBe(403);
    // A reader, a visitor, a CI job and an agent's own token do not.
    expect((await ask("work/a", { as: carol })).status).toBe(403);
    expect((await ask("work/a", {})).status).toBe(404);
    expect((await ask("work/a", { job: { repositoryId: id, write: true } })).status).toBe(403);
    expect((await ask("work/a", await agentOf(given.body.token))).status).toBe(403);
    expect((await ask("no-such-branch")).status).toBe(404);
  });

  it("is not given for a page that is closed", async () => {
    const closed = await world.call("POST", `${page("work/b")}/close`, {
      as: alice,
    });
    expect(closed.status).toBe(200);
    expect((await ask("work/b")).status).toBe(422);
  });

  it("records, answers and reports on its own branch", async () => {
    const agent = await agentOf((await ask("work/a")).body.token);
    const recorded = await world.call("POST", `${repo}/traces`, {
      ...agent,
      body: {
        branch: "work/a",
        agent: { kind: "mcp", name: "Claude Code" },
        entries: [
          { kind: "ask", body: "Add rate limits." },
          {
            kind: "step",
            body: "Added the limiter.",
            anchors: [{ path: "src/a.ts", startLine: 3 }],
          },
          { kind: "decision", body: "A token bucket, not a window: bursts are fine here." },
          {
            kind: "evidence",
            body: "Tests pass.",
            evidence: { command: "pnpm test", exitCode: 0, output: "12 passed" },
          },
          { kind: "doubt", body: "Not run against production traffic." },
          { kind: "note", body: "The limit is per key." },
        ],
      },
    });
    expect(recorded.status).toBe(200);
    expect(recorded.body.entries.map((entry: { kind: string }) => entry.kind)).toEqual([
      "ask",
      "step",
      "decision",
      "evidence",
      "doubt",
      "note",
    ]);
    // Written by the agent, as nobody.
    expect(recorded.body.entries[0]).toMatchObject({
      author: null,
      agent: { kind: "mcp", name: "Claude Code" },
    });
    expect(
      (await world.call("GET", `${repo}/traces?branch=${encodeURIComponent("work/a")}`, agent)).body
        .items,
    ).toHaveLength(6);

    const sent = await world.call("POST", `${page("work/a")}/instructions`, {
      as: bob,
      body: { source: "text", body: "Use the shared limiter." },
    });
    const listed = await world.call("GET", `${page("work/a")}/instructions`, agent);
    expect(listed.body.instructions.map((each: { id: string }) => each.id)).toEqual([sent.body.id]);
    const instruction = `${page("work/a")}/instructions/${sent.body.id}`;
    expect(
      (await world.call("PUT", `${instruction}/delivered`, { ...agent, body: {} })).body,
    ).toMatchObject({ status: "delivered" });
    expect(
      (await world.call("PUT", `${instruction}/answered`, { ...agent, body: {} })).body,
    ).toMatchObject({ status: "answered" });

    const reported = await world.call("POST", `${page("work/a")}/findings`, {
      ...agent,
      body: {
        reviewerKind: "claude-review",
        findings: [{ severity: "should_fix", title: "No test for the burst", path: "src/a.ts" }],
      },
    });
    expect(reported.status).toBe(200);
    expect(reported.body.findings[0]).toMatchObject({
      reviewerKind: "claude-review",
      severity: "should_fix",
    });
    expect(
      (await world.call("GET", `${page("work/a")}/findings`, agent)).body.findings,
    ).toHaveLength(1);
    // The forge's own reviewers' names stay theirs.
    expect(
      (
        await world.call("POST", `${page("work/a")}/findings`, {
          ...agent,
          body: { reviewerKind: "security", findings: [] },
        })
      ).status,
    ).toBe(422);
  });

  it("reads its own branch's page, which the MCP tools look up first", async () => {
    const agent = await agentOf((await ask("work/a")).body.token);
    const read = await world.call("GET", page("work/a"), agent);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ headRef: "work/a" });
  });

  it("reaches no other branch, nothing else of its repository, and no other repository", async () => {
    const agent = await agentOf((await ask("work/a")).body.token);
    const entry = { entries: [{ kind: "step", body: "Elsewhere." }] };
    const sent = await world.call("POST", `${page("work/b")}/instructions`, {
      as: bob,
      body: { source: "text", body: "For the other branch." },
    });
    const own = await world.call("POST", `${page("work/a")}/instructions`, {
      as: bob,
      body: { source: "text", body: "For this branch." },
    });
    const finding = await world.call("POST", `${page("work/a")}/findings`, {
      as: bob,
      body: { reviewerKind: "licenses", findings: [{ severity: "must_fix", title: "No header" }] },
    });
    const findingId = finding.body.findings[0].id;

    const refused: Array<[string, string, unknown?]> = [
      // Another branch's markers.
      ["POST", `${repo}/traces`, { branch: "work/b", ...entry }],
      ["POST", `${repo}/traces`, { branch: "main", ...entry }],
      ["GET", `${repo}/traces?branch=${encodeURIComponent("work/b")}`],
      ["GET", `${page("work/b")}/instructions`],
      ["PUT", `${page("work/b")}/instructions/${sent.body.id}/delivered`, {}],
      ["PUT", `${page("work/b")}/instructions/${sent.body.id}/answered`, {}],
      ["GET", `${page("work/b")}/findings`],
      ["POST", `${page("work/b")}/findings`, { reviewerKind: "claude-review", findings: [] }],
      // What a person decides, on its own branch.
      ["POST", `${page("work/a")}/instructions`, { source: "text", body: "Do more." }],
      ["PUT", `${page("work/a")}/instructions/${own.body.id}/dismiss`, {}],
      ["PUT", `${page("work/a")}/findings/${findingId}/dismiss`, { reason: "No." }],
      ["POST", `${page("work/a")}/findings/override`, { reason: "Ship it." }],
      ["POST", `${page("work/a")}/review-runs`, {}],
      ["GET", `${page("work/a")}/review-runs`],
      // Another branch's page, and everything else of the repository.
      ["GET", page("work/b")],
      ["GET", repo],
      ["GET", `${page("work/a")}/versions`],
      ["GET", `${page("work/a")}/agent`],
      ["PUT", `${page("work/a")}/agent`, { kind: "mcp", displayName: "Me" }],
      ["POST", `${page("work/a")}/agent/token`],
      ["POST", `${repo}/statuses/${"a".repeat(40)}`, { context: "ci", state: "success" }],
      ["GET", `${repo}/collaborators`],
      ["PATCH", repo, { description: "Mine now" }],
      ["GET", `${repo}/review-settings`],
      ["GET", "/api/session"],
    ];
    for (const [method, path, body] of refused) {
      const answer = await world.call(method, path, {
        ...agent,
        ...(body === undefined ? {} : { body }),
      });
      expect(answer.status, `${method} ${path}`).toBe(403);
    }
    // The instruction on the other branch is as it was, and the finding still stands.
    expect(
      (await world.call("GET", `${page("work/b")}/instructions`, { as: bob })).body.instructions[0],
    ).toMatchObject({ status: "queued" });
    expect(
      (await world.call("GET", `${page("work/a")}/findings`, { as: bob })).body.findings[0],
    ).toMatchObject({ status: "open" });

    // Another repository, a branch of the same name: missing, like any repository it cannot read.
    await push("work/a", other.id);
    for (const [method, path, body] of [
      ["POST", `${other.path}/traces`, { branch: "work/a", ...entry }],
      ["GET", `${page("work/a", other.path)}/instructions`, undefined],
      ["GET", `${page("work/a", other.path)}/findings`, undefined],
    ] as const) {
      const answer = await world.call(method, path, {
        ...agent,
        ...(body === undefined ? {} : { body }),
      });
      expect(answer.status, `${method} ${path}`).toBe(404);
    }
  });
});
