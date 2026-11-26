/**
 * The MCP server and its authorization server against a real Postgres, with
 * nothing replaced but the storage: the Worker's own wiring (`mcp/mount.ts`),
 * the real credential check, the real JSON API behind the tools, and the
 * SDK's own client driving it. What only the database can prove: a grant is
 * a token like any other, a code is single use because of a primary key, a
 * refresh swaps one row, and what a tool records is what `repoAccess` lets
 * that credential record.
 *
 * The consent page needs a WorkOS session, which a test cannot have, so the
 * code is issued the way the page issues it; the page itself is
 * `mcp/__tests__/oauth.test.ts`.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ciRuns, gitAccessTokens, gitTraceEntries } from "@infrawrench/server-core/db/schema";
import { makeGitApi } from "../../api/server";
import { mintJobToken } from "../../auth/job-token";
import { hashAccessToken } from "../../auth/tokens";
import { db, newId } from "../../db/client";
import type { Env } from "../../env";
import { routeOf } from "../../http/router";
import { serveMcp, serveOAuth, wellKnownFetch } from "../../mcp/mount";
import { challengeOf, issueCode } from "../../mcp/oauth/grants";
import { OAUTH_LIFETIMES } from "../../mcp/oauth/protocol";
import { type Person, type World, configured, makeWorld } from "./world";

vi.mock("../../events/ci", () => ({
  announcePush: vi.fn(async () => {}),
  announcePullRequest: vi.fn(async () => {}),
}));

const ORIGIN = "https://git.example.test";
const REDIRECT = "http://127.0.0.1:43110/callback";
const VERIFIER = "v".repeat(20) + "E".repeat(20) + "7".repeat(20);
/** Assembled here so no line of this file is a token's shape. */
const fakeSecret = `ghp_${"aB3dE6gH9jK2mN5pQ8rS1tU4vW7xY0z".repeat(2).slice(0, 36)}`;

describe.skipIf(!configured)("the MCP server, against a real Postgres", () => {
  let world: World;
  let env: Env;
  let alice: Person, bob: Person, carol: Person;
  let organization: { id: string; slug: string };
  let repository: string;
  let id: string;
  let count = 0;
  const ctx = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined) };

  /** The site, as the Worker routes it. */
  const site = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const route = routeOf(new URL(request.url).pathname);
    if (route.kind === "mcp") return serveMcp(request, env, ctx, api);
    if (route.kind === "oauth") return serveOAuth(request, env, route.action);
    if (route.kind === "well-known") return wellKnownFetch(request, env);
    throw new Error(`not routed: ${request.url}`);
  };
  let api: ReturnType<typeof makeGitApi>;

  beforeAll(async () => {
    world = makeWorld();
    env = {
      ...world.env,
      SITE_ORIGIN: ORIGIN,
      WORKOS_COOKIE_PASSWORD: "a-cookie-password-of-at-least-thirty-two-characters",
      GIT_JOB_TOKEN_KEY: "a-job-token-key-of-at-least-thirty-two-characters",
    } as Env;
    // The real credential check: only the storage is a fake.
    api = makeGitApi({ readers: world.storage.readers });
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
    const name = `mcp-${++count}`;
    const made = await world.repository(alice, organization.slug, name, "private");
    repository = `${organization.slug}/${name}`;
    id = made.id;
    await world.call("PUT", `${made.path}/collaborators/${bob.username}`, {
      as: alice,
      body: { role: "write" },
    });
    await world.call("PUT", `${made.path}/collaborators/${carol.username}`, {
      as: alice,
      body: { role: "read" },
    });
  });

  const form = (path: string, parameters: Record<string, string>) =>
    site(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
    });

  /** A client's sign-in as `person`, from registration to tokens. */
  const signIn = async (person: Person, scopes: Array<"repo:read" | "repo:write">) => {
    const registered = await site(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Example Agent", redirect_uris: [REDIRECT] }),
    });
    const clientId: string = ((await registered.json()) as { client_id: string }).client_id;
    const code = await issueCode(
      {
        userId: person.id,
        clientId,
        clientName: "Example Agent",
        redirectUri: REDIRECT,
        codeChallenge: await challengeOf(VERIFIER),
        scopes,
      },
      { password: env.WORKOS_COOKIE_PASSWORD },
    );
    const exchange = () =>
      form("/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        client_id: clientId,
        resource: `${ORIGIN}/mcp`,
      });
    const answer = await exchange();
    return { clientId, exchange, status: answer.status, tokens: (await answer.json()) as any };
  };

  const connect = async (bearer: string) => {
    const client = new Client({ name: "example-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        fetch: (input, init) => site(input as string | URL, init),
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }),
    );
    await client.listTools();
    return client;
  };
  const textOf = (result: { content?: unknown }): string =>
    ((result.content as Array<{ text?: string }> | undefined) ?? [])
      .map((part) => part.text ?? "")
      .join("\n");
  const grantsOf = (person: Person) =>
    db.select().from(gitAccessTokens).where(eq(gitAccessTokens.userId, person.id));
  const traces = () =>
    db
      .select()
      .from(gitTraceEntries)
      .where(eq(gitTraceEntries.repositoryId, id))
      .orderBy(gitTraceEntries.createdAt);

  it("grants a token that is the person's, and works as one", async () => {
    const { status, tokens } = await signIn(bob, ["repo:read", "repo:write"]);
    expect(status).toBe(200);
    const [grant] = await grantsOf(bob);
    expect(grant).toMatchObject({
      name: "Example Agent (MCP)",
      scopes: ["repo:read", "repo:write"],
      revokedAt: null,
    });
    expect(grant!.id).toMatch(/^mcp_/);
    // Only its hash is stored.
    expect(JSON.stringify(grant)).not.toContain(tokens.access_token);

    const client = await connect(tokens.access_token);
    const who = await client.callTool({ name: "whoami", arguments: {} });
    expect(who.structuredContent).toMatchObject({
      kind: "user",
      username: bob.username,
      user_id: bob.id,
      scopes: ["repo:read", "repo:write"],
      can_write: true,
    });
  });

  it("records a trace as the person, masked, and reads the branch back", async () => {
    const { tokens } = await signIn(bob, ["repo:read", "repo:write"]);
    const client = await connect(tokens.access_token);

    const started = await client.callTool({
      name: "start_work",
      arguments: { repository, ask: "Add rate limits to the API", branch: "rate-limits" },
    });
    expect(started.isError, textOf(started)).toBeFalsy();
    const page = started.structuredContent as { branch: string; pull_request: number; url: string };
    expect(page.branch).toBe("rate-limits");
    expect(page.url).toBe(`${ORIGIN}/${repository}/pulls/${page.pull_request}`);

    const recorded = await client.callTool({
      name: "record_trace",
      arguments: {
        repository,
        branch: "rate-limits",
        agent_name: "Example Agent",
        session: "thread-42",
        entries: [
          { kind: "ask", body: "Add rate limits to the API" },
          {
            kind: "evidence",
            body: `Called it with ${fakeSecret}`,
            anchors: [{ path: "src/http/admission.ts", start_line: 4 }],
            evidence: {
              command: `curl -H 'Authorization: Bearer ${fakeSecret}' ${ORIGIN}`,
              exit_code: 0,
              output: "HTTP/2 200",
            },
          },
          { kind: "doubt", body: "The window may be too short for CI" },
        ],
      },
    });
    expect(recorded.isError, textOf(recorded)).toBeFalsy();
    expect(recorded.structuredContent).toMatchObject({ recorded: 3, branch: "rate-limits" });
    expect(JSON.stringify(recorded.structuredContent)).not.toContain(fakeSecret);

    const rows = await traces();
    expect(rows.map((row) => row.kind)).toEqual(["ask", "evidence", "doubt"]);
    expect(rows[0]).toMatchObject({
      branch: "rate-limits",
      authorUserId: bob.id,
      versionId: null,
      agent: { kind: "mcp", name: "Example Agent", sessionRef: "thread-42" },
    });
    expect(JSON.stringify(rows)).not.toContain(fakeSecret);

    const branch = await client.callTool({
      name: "get_branch",
      arguments: { repository, branch: "rate-limits" },
    });
    expect(branch.isError, textOf(branch)).toBeFalsy();
    expect(branch.structuredContent).toMatchObject({
      pullRequest: { number: page.pull_request, draft: true, headRef: "rate-limits" },
      state: { pendingTraceEntries: 3 },
      versions: [],
    });

    const inbox = await client.callTool({ name: "list_my_branches", arguments: {} });
    expect(inbox.isError, textOf(inbox)).toBeFalsy();
  });

  it("reaches instructions and findings through their tools", async () => {
    const { tokens } = await signIn(bob, ["repo:read", "repo:write"]);
    const client = await connect(tokens.access_token);
    const started = await client.callTool({
      name: "start_work",
      arguments: { repository, ask: "Something", branch: "something" },
    });
    const number = (started.structuredContent as { pull_request: number }).pull_request;
    for (const [name, extra] of [
      ["list_instructions", {}],
      ["list_findings", {}],
    ] as const) {
      const result = await client.callTool({
        name,
        arguments: { repository, pull_request: number, ...extra },
      });
      expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy();
      expect(result.structuredContent).toBeTypeOf("object");
    }
    // A refusal comes back in words: a branch start work made has no version until a push.
    const report = await client.callTool({
      name: "report_finding",
      arguments: { repository, pull_request: number, reviewer: "outside-bot", findings: [] },
    });
    expect(report.isError).toBe(true);
    expect(textOf(report)).toContain("no version yet");
  });

  it("holds a token to its scope and a person to their access", async () => {
    const body = (branch = "feature") => ({
      repository,
      branch,
      entries: [{ kind: "step", body: "did it" }],
    });
    // A token granted only `repo:read` reads and records nothing.
    const readOnly = await connect((await signIn(bob, ["repo:read"])).tokens.access_token);
    expect(
      (await readOnly.callTool({ name: "whoami", arguments: {} })).structuredContent,
    ).toMatchObject({ scopes: ["repo:read"], can_write: false });
    const refused = await readOnly.callTool({ name: "record_trace", arguments: body() });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("repo:write");

    // A reader of the repository, with a token that could write elsewhere.
    const reader = await connect(
      (await signIn(carol, ["repo:read", "repo:write"])).tokens.access_token,
    );
    const noWrite = await reader.callTool({ name: "record_trace", arguments: body() });
    expect(noWrite.isError).toBe(true);
    expect(textOf(noWrite)).toContain("write access");

    // Somebody who cannot see the private repository is told it is not there.
    const stranger = await world.person(`stranger-${count}`);
    const outside = await connect(
      (await signIn(stranger, ["repo:read", "repo:write"])).tokens.access_token,
    );
    const hidden = await outside.callTool({ name: "record_trace", arguments: body() });
    expect(hidden.isError).toBe(true);
    expect(textOf(hidden)).toContain("cannot read it");
    expect(await traces()).toEqual([]);
  });

  it("takes a personal access token and a CI job's token as they are", async () => {
    const created = await world.call("POST", "/api/user/tokens", {
      as: bob,
      body: { name: "headless agent", scopes: ["repo:read", "repo:write"] },
    });
    const personal = await connect(created.body.secret);
    const byToken = await personal.callTool({
      name: "record_trace",
      arguments: { repository, branch: "feature", entries: [{ kind: "step", body: "by token" }] },
    });
    expect(byToken.isError, textOf(byToken)).toBeFalsy();

    const runId = newId();
    await db.insert(ciRuns).values({
      id: runId,
      organizationId: organization.id,
      installationId: 0,
      gitRepositoryId: id,
      repoFullName: repository,
      ownerKey: `git.infrawrench.com-${organization.slug}`,
      repoKey: repository.split("/")[1]!,
      event: "push",
      branch: "feature",
      headRef: "feature",
      defaultBranch: "main",
      sha: "a".repeat(40),
      status: "pending",
      dedupeKey: runId,
    } as typeof ciRuns.$inferInsert);
    const job = await connect(
      await mintJobToken(env.GIT_JOB_TOKEN_KEY, { repositoryId: id, write: false, runId }),
    );
    expect((await job.callTool({ name: "whoami", arguments: {} })).structuredContent).toMatchObject(
      { kind: "ci_job", repository_id: id, ci_run_id: runId },
    );
    const inCi = await job.callTool({
      name: "record_trace",
      arguments: {
        repository,
        branch: "feature",
        entries: [{ kind: "evidence", body: "ran in CI" }],
      },
    });
    expect(inCi.isError, textOf(inCi)).toBeFalsy();
    // Its run's branch and nothing else, and no other part of the API.
    const elsewhere = await job.callTool({
      name: "record_trace",
      arguments: { repository, branch: "other", entries: [{ kind: "step", body: "x" }] },
    });
    expect(elsewhere.isError).toBe(true);
    const reading = await job.callTool({
      name: "get_branch",
      arguments: { repository, pull_request: 1 },
    });
    expect(reading.isError).toBe(true);
    expect(textOf(reading)).toContain("CI job token");

    expect((await traces()).map((row) => [row.body, row.authorUserId])).toEqual([
      ["by token", bob.id],
      ["ran in CI", null],
    ]);
  });

  it("takes a code once, and ends the grant when it comes again", async () => {
    const { exchange, tokens } = await signIn(bob, ["repo:read"]);
    const before = (await grantsOf(bob)).length;
    const again = await exchange();
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
    expect(await grantsOf(bob)).toHaveLength(before);
    const refusedNow = await site(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: "{}",
    });
    expect(refusedNow.status).toBe(401);
    expect(refusedNow.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("refreshes by swapping the one row, and lists the grant with the tokens", async () => {
    const { clientId, tokens } = await signIn(bob, ["repo:read", "repo:write"]);
    const firstHash = await hashAccessToken(tokens.access_token);
    const grant = (await grantsOf(bob)).find((row) => row.hashedToken === firstHash)!;
    const refreshed = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    // The same row, under the next token's hash: a grant is one row however often it refreshes.
    const same = (await grantsOf(bob)).find((row) => row.id === grant.id)!;
    expect(same.hashedToken).toBe(await hashAccessToken(next.access_token));
    expect(same.revokedAt).toBeNull();
    // The old access token died with the swap; the new one works.
    expect(
      (
        await site(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokens.access_token}` },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    await connect(next.access_token);

    // The person's token list shows it, lasting as long as the connection can.
    const listed = await world.call("GET", "/api/user/tokens", { as: bob });
    const shown = listed.body.tokens.find((token: any) => token.id === same.id);
    expect(shown).toMatchObject({
      name: "Example Agent (MCP)",
      scopes: ["repo:read", "repo:write"],
    });
    const lapses = new Date(shown.expiresAt).getTime() - Date.now();
    expect(lapses).toBeGreaterThan(OAUTH_LIFETIMES.refreshSeconds * 1000);
    expect(lapses).toBeLessThan(
      (OAUTH_LIFETIMES.refreshSeconds + OAUTH_LIFETIMES.accessTokenSeconds + 60) * 1000,
    );

    // And they end it there.
    const revoked = await world.call("DELETE", `/api/user/tokens/${same.id}`, { as: bob });
    expect(revoked.status).toBe(200);
    expect(
      (
        await site(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${next.access_token}` },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const afterwards = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: next.refresh_token,
      client_id: clientId,
    });
    expect(afterwards.status).toBe(400);
  });

  it("lets a client end its own grant", async () => {
    const { tokens } = await signIn(bob, ["repo:read"]);
    expect((await form("/oauth/revoke", { token: tokens.refresh_token })).status).toBe(200);
    const refused = await site(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: "{}",
    });
    expect(refused.status).toBe(401);
  });

  it("serves discovery from the site's own origin", async () => {
    const resource = (await (
      await site(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const unauthenticated = await site(`${ORIGIN}/mcp`, { method: "POST", body: "{}" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    );
  });
});
