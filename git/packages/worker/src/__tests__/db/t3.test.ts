/**
 * T3 Code against a real Postgres and a fake environment
 * (`helpers/fake-t3.ts`): connecting one, signing in to it (and who may
 * finish a sign-in), what is stored, starting work in it, instructions
 * reaching its thread, and an Infrawrench agent's link.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gitInstructions, gitT3Environments } from "@infrawrench/server-core/db/schema";
import type { Authenticated } from "../../auth/authenticate";
import { db } from "../../db/client";
import { sweepInstructions } from "../../review/instructions";
import { handleT3Callback } from "../../t3/callback";
import { LOCALHOST_REFUSAL } from "../../t3/http";
import { type FakeT3, fakeT3 } from "../helpers/fake-t3";
import { type Person, type World, configured, makeWorld, pagePath } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

process.env["ENCRYPTION_MASTER_KEY"] ??= Buffer.alloc(32, 7).toString("base64");

describe.skipIf(!configured)("T3 Code, against a real Postgres", () => {
  let world: World;
  let alice: Person, bob: Person;
  let t3: FakeT3;
  let count = 0;

  const sessionOf = (person: Person | null) => async (): Promise<Authenticated> => ({
    principal: person
      ? { kind: "user", userId: person.id, via: "session", scopes: null, credentialId: null }
      : { kind: "anonymous" },
    refused: false,
    setCookies: [],
    email: null,
  });

  /** The browser coming back from the environment, in `as`'s session. */
  const comeBack = async (query: Record<string, string>, as: Person | null): Promise<string> => {
    const url = new URL("https://git.example.test/auth/t3/callback");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await handleT3Callback(new Request(url), world.env, {
      authenticate: sessionOf(as),
    });
    expect(response.status).toBe(302);
    return response.headers.get("location")!;
  };

  const rowOf = async (environmentId: string) =>
    (await db.select().from(gitT3Environments).where(eq(gitT3Environments.id, environmentId)))[0]!;

  const add = async (as: Person, baseUrl = t3.origin) =>
    world.call("POST", "/api/t3/environments", { as, body: { label: "Laptop", baseUrl } });

  /** An environment `as` has signed in to. */
  const connect = async (as: Person): Promise<string> => {
    const created = await add(as);
    expect(created.status).toBe(200);
    const begun = await world.call("POST", `/api/t3/environments/${created.body.id}/oauth/begin`, {
      as,
      body: {},
    });
    expect(begun.status).toBe(200);
    expect(await comeBack(t3.approve(begun.body.authorizeUrl), as)).toBe(
      "/settings/t3?t3=connected",
    );
    return created.body.id;
  };

  beforeAll(async () => {
    world = makeWorld();
    [alice, bob] = (await Promise.all(["alice", "bob"].map((name) => world.person(name)))) as [
      Person,
      Person,
    ];
  });
  afterAll(() => world?.cleanup());
  beforeEach(() => {
    // An environment a test: a person has one row per address.
    t3 = fakeT3({ origin: `https://t3-${++count}-${world.suffix}.example.net` });
    vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => t3.fetch(String(input), init));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("adds an environment by a public https address, for the session's person only", async () => {
    for (const address of ["http://localhost:3773", "https://127.0.0.1:3773/mcp"]) {
      const refused = await add(alice, address);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(LOCALHOST_REFUSAL);
    }
    for (const address of [
      "https://10.1.2.3",
      "https://169.254.169.254",
      "http://t3.example.net",
      "https://git.example.test",
    ]) {
      expect((await add(alice, address)).status, address).toBe(400);
    }
    // Nothing was asked of anybody yet: adding one stores an address.
    expect(t3.requests).toEqual([]);

    const created = await add(alice, `${t3.origin}/mcp`);
    expect(created.body).toMatchObject({
      label: "Laptop",
      baseUrl: t3.origin,
      status: "pending",
      scopes: [],
      tokenExpiresAt: null,
      lastError: null,
    });
    expect((await add(alice)).status).toBe(409);
    // The same address is somebody else's to add too.
    expect((await add(bob)).status).toBe(200);

    expect((await world.call("GET", "/api/t3/environments")).status).toBe(401);
    expect(
      (await world.call("GET", "/api/t3/environments", { as: alice, scopes: ["repo:write"] }))
        .status,
    ).toBe(403);
    const mine = (await world.call("GET", "/api/t3/environments", { as: alice })).body
      .environments as Array<{ id: string }>;
    expect(mine.map((each) => each.id)).toEqual([created.body.id]);

    // Somebody else's environment is not there.
    const theirs = `/api/t3/environments/${created.body.id}`;
    expect((await world.call("PATCH", theirs, { as: bob, body: { label: "x" } })).status).toBe(404);
    expect((await world.call("DELETE", theirs, { as: bob })).status).toBe(404);
    expect((await world.call("POST", `${theirs}/oauth/begin`, { as: bob, body: {} })).status).toBe(
      404,
    );
    expect((await world.call("GET", `${theirs}/threads`, { as: bob })).status).toBe(404);
    expect(
      (await world.call("PATCH", theirs, { as: alice, body: { label: "Desk" } })).body.label,
    ).toBe("Desk");
  });

  it("signs in: only in the session that began it, once, and stores the token sealed", async () => {
    const created = await add(alice);
    const id = created.body.id as string;
    // Not signed in yet: there is nothing to ask the environment with.
    expect(
      (await world.call("GET", `/api/t3/environments/${id}/threads`, { as: alice })).status,
    ).toBe(422);
    const begun = await world.call("POST", `/api/t3/environments/${id}/oauth/begin`, {
      as: alice,
      body: { returnTo: "/alice/repo/work/new?agent=t3" },
    });
    const authorize = new URL(begun.body.authorizeUrl);
    expect(authorize.origin).toBe(t3.origin);
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://git.example.test/auth/t3/callback",
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const pending = await rowOf(id);
    expect(pending.oauthState).toBe(authorize.searchParams.get("state"));
    expect(pending.oauthStateExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(pending.oauthClientId).toMatch(/^client\.id-/);

    const back = t3.approve(begun.body.authorizeUrl);
    // Somebody else's browser, or nobody's: nothing is exchanged and the state is left alone.
    expect(await comeBack(back, bob)).toBe("/settings/t3?t3=failed");
    expect(await comeBack(back, null)).toBe("/settings/t3?t3=failed");
    expect((await rowOf(id)).oauthState).toBe(back.state);
    expect(t3.requests.filter((request) => request.url.endsWith("/oauth/mcp/token"))).toEqual([]);

    expect(await comeBack(back, alice)).toBe("/alice/repo/work/new?agent=t3&t3=connected");
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "connected", oauthState: null, lastError: null });
    expect(row.scopes).toContain("orchestration:operate");
    expect(row.tokenExpiresAt!.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    // Sealed: the token is in neither column as itself, and in no answer.
    expect(row.credentialsCiphertext).toMatch(/^v2:/);
    expect(row.credentialsCiphertext).not.toContain("access.token");
    const answer = (await world.call("GET", "/api/t3/environments", { as: alice })).body;
    expect(JSON.stringify(answer)).not.toMatch(/access\.token|credentials|oauthState|client\.id/);
    expect(
      (answer.environments as Array<{ id: string }>).find((each) => each.id === id),
    ).toMatchObject({ status: "connected" });

    // The same answer a second time finds no sign-in in progress.
    expect(await comeBack(back, alice)).toBe("/settings/t3?t3=failed");
    expect((await rowOf(id)).status).toBe("connected");
  });

  it("refuses a sign-in that came back wrong, and says why on the row", async () => {
    const id = (await add(alice)).body.id as string;
    const begin = async (returnTo?: string) =>
      (
        await world.call("POST", `/api/t3/environments/${id}/oauth/begin`, {
          as: alice,
          body: returnTo === undefined ? {} : { returnTo },
        })
      ).body.authorizeUrl as string;

    // Declined in T3 Code.
    let url = await begin();
    const state = new URL(url).searchParams.get("state")!;
    expect(await comeBack({ state, error: "access_denied" }, alice)).toBe("/settings/t3?t3=failed");
    expect(await rowOf(id)).toMatchObject({
      status: "error",
      oauthState: null,
      lastError: "The sign-in was declined in T3 Code",
    });

    // From another issuer than the one that was asked.
    url = await begin();
    expect(
      await comeBack({ ...t3.approve(url), iss: "https://elsewhere.example.org" }, alice),
    ).toBe("/settings/t3?t3=failed");
    expect((await rowOf(id)).lastError).toBe("The sign-in came back from a different server");

    // A code that is not this sign-in's.
    url = await begin();
    expect(await comeBack({ ...t3.approve(url), code: "code-from-somewhere-else" }, alice)).toBe(
      "/settings/t3?t3=failed",
    );
    expect((await rowOf(id)).status).toBe("error");

    // Too late.
    url = await begin();
    await db
      .update(gitT3Environments)
      .set({ oauthStateExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(gitT3Environments.id, id));
    expect(await comeBack(t3.approve(url), alice)).toBe("/settings/t3?t3=failed");

    // Where to go back to is a path on this site or nothing.
    for (const elsewhere of ["https://evil.example.org/x", "//evil.example.org", "/\\evil"]) {
      url = await begin(elsewhere);
      expect(await comeBack(t3.approve(url), alice)).toBe("/settings/t3?t3=connected");
    }
    // The site registered once, with that server, however often it signed in.
    expect(t3.registrations).toHaveLength(1);
    expect((await rowOf(id)).status).toBe("connected");
  });

  it("says when an address is not a T3 Code environment, or is asleep", async () => {
    const id = (await add(alice)).body.id as string;
    t3.down = true;
    const asleep = await world.call("POST", `/api/t3/environments/${id}/oauth/begin`, {
      as: alice,
      body: {},
    });
    expect(asleep).toMatchObject({
      status: 422,
      body: { error: "The environment did not answer" },
    });
    expect((await rowOf(id)).lastError).toBe("The environment did not answer");
    t3.down = false;
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 404 }));
    const other = await world.call("POST", `/api/t3/environments/${id}/oauth/begin`, {
      as: alice,
      body: {},
    });
    expect(other.status).toBe(422);
    expect(other.body.error).toContain("does not answer as a T3 Code environment");
  });

  it("lists an environment's threads, and notices a sign-in that ended", async () => {
    const id = await connect(alice);
    t3.projects.push({ id: "p1", title: "infra", workspaceRoot: "/w/infra", remoteUrl: null });
    t3.threads.push(
      {
        threadId: "t-old",
        projectId: "p1",
        title: "Rate limits",
        status: "idle",
        updatedAt: "2026-11-01T10:00:00.000Z",
        messages: [],
        launch: {},
      },
      {
        threadId: "t-new",
        projectId: "p-gone",
        title: "Flow logs",
        status: "running",
        updatedAt: "2026-11-20T10:00:00.000Z",
        messages: [],
        launch: {},
      },
    );
    const threads = await world.call("GET", `/api/t3/environments/${id}/threads`, { as: alice });
    expect(threads.body.threads).toEqual([
      {
        id: "t-new",
        title: "Flow logs",
        projectId: "p-gone",
        projectName: null,
        updatedAt: "2026-11-20T10:00:00.000Z",
      },
      {
        id: "t-old",
        title: "Rate limits",
        projectId: "p1",
        projectName: "infra",
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
    ]);
    expect(
      (await world.call("GET", `/api/t3/environments/${id}/threads?q=rate`, { as: alice })).body
        .threads,
    ).toHaveLength(1);
    expect((await rowOf(id)).lastUsedAt).not.toBeNull();

    // Removed from T3 Code's own settings: the token stops working.
    t3.revokeAll();
    const ended = await world.call("GET", `/api/t3/environments/${id}/threads`, { as: alice });
    expect(ended.status).toBe(422);
    expect(await rowOf(id)).toMatchObject({ status: "error" });
    expect((await rowOf(id)).lastError).toContain("Sign in to it again");
  });

  it("refreshes a token that is about to expire, once, where the environment rotates them", async () => {
    t3 = fakeT3({ origin: t3.origin, refresh: true });
    const id = await connect(alice);
    const before = (await rowOf(id)).credentialsCiphertext;
    await db
      .update(gitT3Environments)
      .set({ tokenExpiresAt: new Date(Date.now() + 30_000) })
      .where(eq(gitT3Environments.id, id));
    const grants = () =>
      t3.requests.filter(
        (request) =>
          request.url.endsWith("/oauth/mcp/token") &&
          request.body.includes("grant_type=refresh_token"),
      ).length;
    // Thirty seconds left: both of these need a new token, and one of them gets it.
    const [one, two] = await Promise.all([
      world.call("GET", `/api/t3/environments/${id}/threads`, { as: alice }),
      world.call("GET", `/api/t3/environments/${id}/threads`, { as: alice }),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(grants()).toBe(1);
    const after = await rowOf(id);
    expect(after.credentialsCiphertext).not.toBe(before);
    expect(after.tokenExpiresAt!.getTime() - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);
    // With time left, nothing is refreshed.
    await world.call("GET", `/api/t3/environments/${id}/threads`, { as: alice });
    expect(grants()).toBe(1);

    // A refresh token the environment no longer takes: signed out, and it says so.
    t3.revokeAll();
    await db
      .update(gitT3Environments)
      .set({ tokenExpiresAt: new Date(Date.now() + 30_000) })
      .where(eq(gitT3Environments.id, id));
    const ended = await world.call("GET", `/api/t3/environments/${id}/threads`, { as: alice });
    expect(ended).toMatchObject({
      status: 422,
      body: { error: "Sign in to this environment again" },
    });
    expect(await rowOf(id)).toMatchObject({ status: "error", tokenExpiresAt: null });
  });

  describe("work in an environment", () => {
    let repo: string;
    let environmentId: string;
    const ask = "Add rate limits to the API\n\nPer key, 100 a minute.";
    const start = (as: Person, agent: Record<string, unknown>) =>
      world.call("POST", `${repo}/work`, { as, body: { ask, agent } });

    beforeEach(async () => {
      repo = (await world.repository(alice, alice.username, `t3-${count}`)).path;
      environmentId = await connect(alice);
    });

    it("clones the repository, launches a thread on a worktree, and names it on the branch", async () => {
      const started = await start(alice, {
        kind: "t3",
        displayName: "T3 Code",
        t3EnvironmentId: environmentId,
      });
      expect(started.status).toBe(200);
      const name = repo.split("/").slice(-2).join("/");
      const cloneUrl = `https://git.example.test/${name}.git`;
      const tools = t3.calls.map((call) => call.tool);
      expect(tools).toEqual([
        "t3_project_list",
        "t3_project_clone",
        "t3_project_create",
        "t3_thread_launch",
        // The names of the model the thread got, for the branch's page.
        "orchestrator_capabilities",
      ]);
      expect(t3.calls[1]!.args).toEqual({
        remoteUrl: cloneUrl,
        destinationPath: `~/infrawrench-git/${name}`,
      });
      const launch = t3.calls[3]!.args;
      expect(launch).toMatchObject({
        projectId: t3.projects[0]!.id,
        title: "Add rate limits to the API",
        workspaceStrategy: {
          type: "worktree",
          baseRef: "origin/main",
          branch: "work/add-rate-limits-to-the-api",
          startFromOrigin: true,
        },
      });
      expect(launch["clientRequestId"]).toBe(`infrawrench-git:work:${started.body.page.id}`);
      const message = String(launch["message"]);
      expect(message).toContain("Per key, 100 a minute.");
      expect(message).toContain("git push -u origin work/add-rate-limits-to-the-api");
      expect(message).toContain(
        `https://git.example.test/${name}/branches/${started.body.page.key}`,
      );
      expect(message).toContain(
        "claude mcp add --transport http infrawrench-git https://git.example.test/mcp",
      );
      // The thread asks for its own token for this branch's page: none is sent to it.
      expect(message).toContain(
        `/branches/${encodeURIComponent(started.body.page.key)}/agent/token`,
      );
      expect(JSON.stringify(t3.calls)).not.toMatch(/iw[a-z]_[A-Za-z0-9_-]{8,}/);
      // Nothing of the forge's own goes to the environment: no session, no token.
      for (const request of t3.requests) {
        expect(request.headers["cookie"]).toBeUndefined();
        expect(`${request.body} ${JSON.stringify(request.headers)}`).not.toMatch(
          /iw[gjk]_|x-test-user/,
        );
      }

      const thread = t3.threads[0]!;
      expect(started.body.agent).toMatchObject({
        kind: "t3",
        displayName: "T3 Code",
        t3EnvironmentId: environmentId,
        externalRefs: {
          threadId: thread.threadId,
          projectId: t3.projects[0]!.id,
          threadUrl: `https://app.t3.codes/threads/env-1/${thread.threadId}`,
        },
      });

      // The agent, asked for, says what its thread is doing.
      const agent = await world.call("GET", `${pagePath(repo, started.body.page.key)}/agent`, {
        as: alice,
      });
      expect(agent.body.agent.externalRefs).toMatchObject({ threadStatus: "running" });

      // The environment has the repository now: the next ask clones nothing.
      t3.calls.length = 0;
      const second = await start(alice, {
        kind: "t3",
        displayName: "T3 Code",
        t3EnvironmentId: environmentId,
      });
      expect(second.status).toBe(200);
      expect(t3.calls.map((call) => call.tool)).toEqual([
        "t3_project_list",
        "t3_thread_launch",
        "orchestrator_capabilities",
      ]);
      expect(t3.threads).toHaveLength(2);
    });

    it("refuses before making a branch when the environment will not take the work", async () => {
      const branches = async () =>
        (await world.call("GET", `${repo}/branch-pages?state=all`, { as: alice })).body.items
          .length;
      // Somebody else's environment.
      expect(
        (await start(bob, { kind: "t3", displayName: "T3 Code", t3EnvironmentId: environmentId }))
          .status,
      ).not.toBe(200);
      // Approved for reading only: T3 Code refuses the clone, in its own words.
      t3.access = "read-only";
      const readOnly = await connect(bob);
      await world.call("PUT", `${repo}/collaborators/${bob.username}`, {
        as: alice,
        body: { role: "write" },
      });
      const refused = await start(bob, {
        kind: "t3",
        displayName: "T3 Code",
        t3EnvironmentId: readOnly,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toContain("approved for read-only access");
      // Not signed in.
      const pending = (await add(bob, "https://another-t3.example.net")).body.id;
      const unsigned = await start(bob, {
        kind: "t3",
        displayName: "T3 Code",
        t3EnvironmentId: pending,
      });
      expect(unsigned).toMatchObject({
        status: 422,
        body: { error: "Sign in to that T3 Code environment first" },
      });
      expect(await branches()).toBe(0);
    });

    it("keeps the page when the launch fails, and starts the thread when asked again", async () => {
      t3.failNext["t3_thread_launch"] = "The worktree could not be made. No thread was created.";
      const started = await start(alice, {
        kind: "t3",
        displayName: "T3 Code",
        t3EnvironmentId: environmentId,
      });
      expect(started.status).toBe(200);
      expect(started.body.agent.externalRefs.launchError).toContain(
        "The worktree could not be made",
      );
      // The branch's page says so too: its state carries the link.
      const state = await world.call(
        "GET",
        `${pagePath(repo, started.body.page.key)}/branch-state`,
        {
          as: alice,
        },
      );
      expect(state.body.agent.externalRefs.launchError).toContain("The worktree could not be made");
      expect(started.body.agent.externalRefs.threadId).toBeUndefined();
      expect(t3.threads).toHaveLength(0);

      const again = await world.call("PUT", `${pagePath(repo, started.body.page.key)}/agent`, {
        as: alice,
        body: {
          kind: "t3",
          displayName: "T3 Code",
          t3EnvironmentId: environmentId,
          // What a client echoes back is not what the forge believes.
          externalRefs: {
            launchError: "stale",
            startUrl: "https://evil.example.org",
            modelName: "Somebody's model",
            sendError: "stale",
          },
          // Try again, with a model this time.
          t3Model: {
            providerId: "claudeAgent",
            model: "claude-opus-5-5",
            reasoning: { optionId: "effort", level: "xhigh" },
          },
        },
      });
      expect(again.body.agent.externalRefs).toEqual({
        threadId: t3.threads[0]!.threadId,
        projectId: t3.projects[0]!.id,
        threadUrl: expect.stringContaining("https://app.t3.codes/threads/"),
        modelProviderId: "claudeAgent",
        modelId: "claude-opus-5-5",
        modelName: "Claude Opus 5.5",
        reasoningLevel: "xhigh",
      });
      expect(t3.threads[0]!.launch["modelSelection"]).toEqual({
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "xhigh" }],
      });
      // The same key as the first try: a thread that try had made would be found, not doubled.
      expect(t3.threads[0]!.launch["clientRequestId"]).toBe(
        `infrawrench-git:work:${started.body.page.id}`,
      );
      expect(String(t3.threads[0]!.launch["message"])).toContain("Per key, 100 a minute.");
    });

    it("picks a model when nobody chose and the project has no default", async () => {
      t3.requireModel = true;
      const started = await start(alice, {
        kind: "t3",
        displayName: "T3 Code",
        t3EnvironmentId: environmentId,
      });
      expect(started.status).toBe(200);
      expect(t3.threads).toHaveLength(1);
      expect(started.body.agent.externalRefs).toMatchObject({
        threadId: t3.threads[0]!.threadId,
        modelProviderId: "claudeAgent",
        modelId: "claude-opus-5-5",
        modelName: "Claude Opus 5.5",
        reasoningLevel: "high",
        modelPickedBy: "forge",
      });
      expect(started.body.agent.externalRefs.launchError).toBeUndefined();
      const launches = t3.calls.filter((call) => call.tool === "t3_thread_launch");
      expect(launches.map((call) => call.args["modelSelection"])).toEqual([
        undefined,
        {
          instanceId: "claudeAgent",
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "high" }],
        },
      ]);
      expect(new Set(launches.map((call) => call.args["clientRequestId"])).size).toBe(1);
    });

    it("lists an environment's models, with the default of the repository's project", async () => {
      const name = repo.split("/").slice(-2).join("/");
      const [owner, repository] = name.split("/");
      const models = `/api/t3/environments/${environmentId}/models?owner=${owner}&repo=${repository}`;
      const none = await world.call("GET", models, { as: alice });
      expect(none.status).toBe(200);
      expect(none.body.default).toBeNull();
      // Only what can run a thread: the provider that is not signed in is left out.
      expect(none.body.providers.map((each: { id: string }) => each.id)).toEqual([
        "codex",
        "claudeAgent",
      ]);
      expect(none.body.providers[1].models[0]).toEqual({
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        reasoning: {
          optionId: "effort",
          levels: ["low", "medium", "high", "xhigh"],
          default: "high",
        },
      });

      t3.projects.push({
        id: "p-default",
        title: name,
        workspaceRoot: "/w/it",
        remoteUrl: `https://git.example.test/${name}.git`,
        defaultModelSelection: {
          instanceId: "codex",
          model: "gpt-6-astra",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });
      const preset = await world.call("GET", models, { as: alice });
      expect(preset.body.default).toEqual({
        providerId: "codex",
        model: "gpt-6-astra",
        reasoning: { optionId: "reasoningEffort", level: "low" },
      });
      // Somebody else's environment is not theirs to ask.
      expect((await world.call("GET", models, { as: bob })).status).toBe(404);
    });

    it("names an existing thread without starting one", async () => {
      const started = await world.call("POST", `${repo}/work`, { as: alice, body: { ask } });
      t3.calls.length = 0;
      const set = await world.call("PUT", `${pagePath(repo, started.body.page.key)}/agent`, {
        as: alice,
        body: {
          kind: "t3",
          displayName: "T3 Code",
          t3EnvironmentId: environmentId,
          externalRefs: { threadId: "t-existing" },
        },
      });
      expect(set.body.agent.externalRefs).toEqual({ threadId: "t-existing" });
      expect(t3.calls).toEqual([]);
    });

    it("sends an instruction to the thread, and catches up when the environment was away", async () => {
      const started = await start(alice, {
        kind: "t3",
        displayName: "T3 Code",
        t3EnvironmentId: environmentId,
      });
      const pull = `${pagePath(repo, started.body.page.key)}`;
      const thread = t3.threads[0]!;
      const sent = await world.call("POST", `${pull}/instructions`, {
        as: alice,
        body: { source: "text", body: "Use the shared limiter." },
      });
      expect(sent.body).toMatchObject({ status: "delivered", deliveredVia: "t3" });
      const send = t3.calls.at(-1)!;
      expect(send.tool).toBe("t3_thread_send");
      expect(send.args).toMatchObject({
        threadId: thread.threadId,
        mode: "auto",
        clientRequestId: `infrawrench-git:instruction:${sent.body.id}`,
      });
      expect(thread.messages.at(-1)).toContain("Use the shared limiter.");
      expect(thread.messages.at(-1)).toContain(`Its id is ${sent.body.id}.`);
      expect(thread.messages.at(-1)).toContain("work/add-rate-limits-to-the-api");
      // How to mark it, and how to get a token again; never a token.
      expect(thread.messages.at(-1)).toContain("mark_instruction_answered");
      expect(thread.messages.at(-1)).toContain(
        `/branches/${encodeURIComponent(started.body.page.key)}/agent/token`,
      );
      expect(JSON.stringify(t3.calls)).not.toMatch(/iw[a-z]_[A-Za-z0-9_-]{8,}/);

      // The laptop is asleep: the instruction waits, and the request still answers.
      t3.down = true;
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      const waiting = await world.call("POST", `${pull}/instructions`, {
        as: alice,
        body: { source: "text", body: "And document it." },
      });
      expect(waiting.body).toMatchObject({ status: "queued", deliveredVia: null });
      // The branch's page says why it waits.
      expect(
        (await world.call("GET", `${pull}/branch-state`, { as: alice })).body.agent.externalRefs,
      ).toMatchObject({ sendError: "The environment did not answer" });
      expect((await rowOf(environmentId)).lastError).toBe("The environment did not answer");
      // Still connected: asleep is not signed out.
      expect((await rowOf(environmentId)).status).toBe("connected");

      t3.down = false;
      await db
        .update(gitInstructions)
        .set({ createdAt: new Date(Date.now() - 5 * 60 * 1000) })
        .where(eq(gitInstructions.id, waiting.body.id));
      await sweepInstructions(world.env);
      quiet.mockRestore();
      expect(thread.messages.at(-1)).toContain("And document it.");
      const after = (await world.call("GET", `${pull}/instructions`, { as: alice })).body
        .instructions as Array<Record<string, any>>;
      expect(after.map((each) => [each["status"], each["deliveredVia"]])).toEqual([
        ["delivered", "t3"],
        ["delivered", "t3"],
      ]);
      expect((await rowOf(environmentId)).lastError).toBeNull();
      const told = (await world.call("GET", `${pull}/branch-state`, { as: alice })).body.agent;
      expect(told.externalRefs.sendError).toBeUndefined();
      expect(told.externalRefs.threadId).toBe(thread.threadId);
    });

    it("forgets an environment and its sign-in, and its branches fall back to asking", async () => {
      const started = await start(alice, {
        kind: "t3",
        displayName: "T3 Code",
        t3EnvironmentId: environmentId,
      });
      const pull = `${pagePath(repo, started.body.page.key)}`;
      expect(
        (await world.call("DELETE", `/api/t3/environments/${environmentId}`, { as: alice })).status,
      ).toBe(200);
      expect(await rowOf(environmentId)).toBeUndefined();
      const agent = (await world.call("GET", `${pull}/agent`, { as: alice })).body.agent;
      expect(agent).toMatchObject({ kind: "t3", t3EnvironmentId: null });
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      const sent = await world.call("POST", `${pull}/instructions`, {
        as: alice,
        body: { source: "text", body: "Anyone there?" },
      });
      quiet.mockRestore();
      expect(sent.body.status).toBe("queued");
    });
  });

  it("links an Infrawrench agent by where the app starts it, for an organisation's repository", async () => {
    const personal = (await world.repository(alice, alice.username, `own-${count}`)).path;
    const refused = await world.call("POST", `${personal}/work`, {
      as: alice,
      body: { ask: "Do it", agent: { kind: "infrawrench", displayName: "Infrawrench" } },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("Infrawrench agents run in an organisation");

    const org = await world.organization(`acme${count}`, {
      paid: true,
      members: [[alice, "owner"]],
    });
    const repo = (await world.repository(alice, org.slug, "infra", "private")).path;
    const started = await world.call("POST", `${repo}/work`, {
      as: alice,
      body: {
        ask: "Do it",
        agent: {
          kind: "infrawrench",
          displayName: "Infrawrench",
          externalRefs: { startUrl: "https://evil.example.org", organizationId: "not-this-one" },
        },
      },
    });
    expect(started.status).toBe(200);
    expect(started.body.agent).toMatchObject({
      kind: "infrawrench",
      externalRefs: {
        organizationId: org.id,
        startUrl: `https://app.example.test/org/${org.id}/agents?git=${encodeURIComponent(
          `${org.slug}/infra`,
        )}&branch=${encodeURIComponent(started.body.page.key)}`,
      },
    });
    // Nothing was asked of any environment.
    expect(t3.requests).toEqual([]);
  });
});
