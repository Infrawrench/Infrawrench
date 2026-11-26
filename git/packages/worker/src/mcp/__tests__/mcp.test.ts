/**
 * The MCP server at the protocol's level, driven by the SDK's own client
 * over the site's `fetch` (`harness.ts`): both protocol eras, every tool
 * against a mocked JSON API, what a refusal looks like, and a client's whole
 * OAuth sign-in (discovery, registration, PKCE, the consent page, refresh,
 * revocation) as that client performs it.
 */
import {
  Client,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import type { Principal } from "../../auth/principal";
import { mintAccessToken } from "../../auth/tokens";
import { clientNameOf } from "../http";
import { OAUTH_LIFETIMES } from "../oauth/protocol";
import { MCP_SERVER_NAME } from "../server";
import { TOOLS, repositoryPath } from "../tools";
import { ORIGIN, type Site, type SiteOptions, browse, makeSite } from "./harness";

const MCP_URL = `${ORIGIN}/mcp`;
const REPO = "/api/repos/acme/infra";

type Era = "legacy" | "modern";

/** A site with one personal token already made, as a headless agent would have. */
const siteWithToken = async (
  options: SiteOptions = {},
  scopes: Array<"repo:read" | "repo:write"> = ["repo:read", "repo:write"],
) => {
  const site = makeSite(options);
  const minted = await mintAccessToken();
  await site.store.insert({
    id: "token-1",
    userId: "alice",
    name: "agent",
    prefix: minted.prefix,
    hash: minted.hash,
    scopes,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { site, token: minted.secret };
};

const connect = async (
  site: Site,
  authorization: string,
  era: Era = "legacy",
  headers: Record<string, string> = {},
) => {
  const client = new Client(
    { name: "test-agent", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (input, init) => site.fetch(input as string | URL, init),
      requestInit: { headers: { authorization, ...headers } },
    }),
  );
  return client;
};

/** A JSON API that answers each `METHOD path` with what the table says. */
const apiOf =
  (table: Record<string, unknown | ((request: Request) => unknown | Promise<unknown>)>) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const answer = table[`${request.method} ${url.pathname}`];
    if (answer === undefined) return Response.json({ error: "Not found" }, { status: 404 });
    const body = typeof answer === "function" ? await answer(request) : answer;
    return body instanceof Response ? body : Response.json(body);
  };

const PULLS = { items: [{ number: 7 }], nextCursor: null };
const textOf = (result: { content?: unknown }): string =>
  ((result.content as Array<{ text?: string }> | undefined) ?? [])
    .map((part) => part.text ?? "")
    .join("\n");

describe("the endpoint", () => {
  it("tells a caller without a credential where to get one", async () => {
    const site = makeSite();
    const response = await site.fetch(MCP_URL, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate")!;
    expect(challenge).toContain(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain('scope="repo:read repo:write"');
    expect(challenge).not.toContain("error=");
    // A browser-based client must be able to read the challenge.
    expect(response.headers.get("access-control-expose-headers")).toContain("www-authenticate");
    expect(site.apiCalls).toEqual([]);
  });

  it("says a refused credential is invalid, whatever kind it was", async () => {
    const { site, token } = await siteWithToken();
    await site.store.revoke("token-1");
    for (const authorization of [
      `Bearer ${token}`,
      "Bearer iwg_nope",
      "Bearer nonsense",
      "Basic eDp5",
    ]) {
      const response = await site.fetch(MCP_URL, {
        method: "POST",
        headers: { authorization },
        body: "{}",
      });
      expect([authorization, response.status]).toEqual([authorization, 401]);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
  });

  it("never takes the session cookie", async () => {
    const site = makeSite();
    const response = await site.fetch(MCP_URL, {
      method: "POST",
      headers: { cookie: "session=alice", origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("answers any origin, and a preflight without a credential", async () => {
    const { site, token } = await siteWithToken();
    const preflight = await site.fetch(MCP_URL, {
      method: "OPTIONS",
      headers: {
        origin: "https://inspector.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, mcp-protocol-version",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    const client = await connect(site, `Bearer ${token}`);
    expect((await client.listTools()).tools.length).toBe(TOOLS.length);
    const malformed = await site.fetch(MCP_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "not an origin" },
      body: "{}",
    });
    expect(malformed.status).toBe(403);
  });

  it("has nothing to GET or DELETE, and reads only JSON", async () => {
    const { site, token } = await siteWithToken();
    const headers = { authorization: `Bearer ${token}` };
    for (const method of ["GET", "DELETE"]) {
      const response = await site.fetch(MCP_URL, { method, headers });
      expect(response.status).toBe(405);
    }
    const garbled = await site.fetch(MCP_URL, { method: "POST", headers, body: "{not json" });
    expect(garbled.status).toBe(400);
    expect((await garbled.json()).error.code).toBe(-32700);
  });

  it("takes a client's name from its user agent when it gives no other", () => {
    expect(clientNameOf("claude-code/2.1.0 (cli)")).toBe("claude-code");
    expect(clientNameOf("Codex CLI/0.30")).toBe("Codex CLI");
    expect(clientNameOf("node")).toBeNull();
    expect(clientNameOf("Mozilla/5.0 (Macintosh)")).toBeNull();
    expect(clientNameOf(null)).toBeNull();
  });
});

describe.each(["legacy", "modern"] as const)("the %s protocol era", (era) => {
  it("introduces itself and lists every tool with its schemas", async () => {
    const { site, token } = await siteWithToken();
    const client = await connect(site, `Bearer ${token}`, era);
    expect(client.getServerVersion()).toMatchObject({ name: MCP_SERVER_NAME });
    expect(client.getInstructions()).toContain("record_trace");

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "whoami",
      "list_my_branches",
      "get_branch",
      "get_version_diff",
      "record_trace",
      "list_instructions",
      "mark_instruction_delivered",
      "mark_instruction_answered",
      "list_findings",
      "report_finding",
      "start_work",
    ]);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z_]*$/);
      expect(tool.description!.length).toBeGreaterThan(80);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect(tool.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    }
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).toEqual([
      "whoami",
      "list_my_branches",
      "get_branch",
      "get_version_diff",
      "list_instructions",
      "list_findings",
    ]);
    // Listing asks the forge nothing.
    expect(site.apiCalls).toEqual([]);
  });

  it("calls a tool with the caller's credential and nothing else of the request", async () => {
    const { site, token } = await siteWithToken({
      api: apiOf({ "GET /api/session": { user: { username: "alice", displayName: "Alice" } } }),
    });
    const client = await connect(site, `Bearer ${token}`, era);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      kind: "user",
      username: "alice",
      display_name: "Alice",
      user_id: "alice",
      scopes: ["repo:read", "repo:write"],
      can_write: true,
      repository_id: null,
      ci_run_id: null,
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    expect(site.apiCalls).toHaveLength(1);
    const call = site.apiCalls[0]!;
    expect(call.url).toBe(`${ORIGIN}/api/session`);
    expect(call.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(call.headers.get("cookie")).toBeNull();
    expect(call.headers.get("origin")).toBeNull();
  });

  it("refuses arguments that do not fit a tool's schema, before the forge is asked", async () => {
    const { site, token } = await siteWithToken();
    const client = await connect(site, `Bearer ${token}`, era);
    const attempt = async (name: string, args: Record<string, unknown>) => {
      try {
        const result = await client.callTool({ name, arguments: args });
        return result.isError === true;
      } catch {
        return true;
      }
    };
    expect(
      await attempt("record_trace", { repository: "acme/infra", branch: "x", entries: [] }),
    ).toBe(true);
    expect(
      await attempt("record_trace", {
        repository: "acme/infra",
        branch: "x",
        entries: [{ kind: "rumour", body: "b" }],
      }),
    ).toBe(true);
    expect(await attempt("get_branch", { repository: "acme/infra", surprise: 1 })).toBe(true);
    expect(await attempt("no_such_tool", {})).toBe(true);
    expect(site.apiCalls).toEqual([]);
  });
});

describe("who a trace says wrote it", () => {
  const recorded = async (era: Era, headers: Record<string, string> = {}) => {
    let agent: unknown;
    const { site, token } = await siteWithToken({
      api: apiOf({
        [`POST ${REPO}/traces`]: async (request: Request) => {
          agent = ((await request.json()) as { agent: unknown }).agent;
          return { entries: [] };
        },
      }),
    });
    const client = await connect(site, `Bearer ${token}`, era, headers);
    await client.callTool({
      name: "record_trace",
      arguments: {
        repository: "acme/infra",
        branch: "feature",
        entries: [{ kind: "step", body: "did it" }],
      },
    });
    return agent;
  };

  it("is the client's own name where the protocol carries it on every request", async () => {
    expect(await recorded("modern")).toEqual({ kind: "mcp", name: "test-agent" });
  });

  it("is the user agent's, or nothing in particular, where it does not", async () => {
    expect(await recorded("legacy", { "user-agent": "claude-code/2.1.0" })).toEqual({
      kind: "mcp",
      name: "claude-code",
    });
    expect(await recorded("legacy")).toEqual({ kind: "mcp", name: "MCP client" });
  });
});

describe("the tools", () => {
  const setup = async (table: Parameters<typeof apiOf>[0], options: SiteOptions = {}) => {
    const { site, token } = await siteWithToken({ ...options, api: apiOf(table) });
    // An earlier-era client says who it is once, at `initialize`; a stateless
    // server hears it again only in the `User-Agent`.
    const client = await connect(site, `Bearer ${token}`, "legacy", {
      "user-agent": "test-agent/1.0.0",
    });
    // The client then checks every structured answer against the tool's output schema.
    await client.listTools();
    const call = async (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const sent = () =>
      site.apiCalls.map((request) => {
        const url = new URL(request.url);
        return `${request.method} ${url.pathname}${url.search}`;
      });
    return { site, call, sent };
  };

  it("whoami says what a read-only token, an API key and a CI job are", async () => {
    const job: Principal = {
      kind: "job",
      repositoryId: "repo-1",
      write: false,
      runId: "run-9",
      workspaceId: null,
    };
    const key: Principal = {
      kind: "api-key",
      apiKeyId: "key-1",
      organizationId: "org-1",
      userId: "alice",
      permissions: ["git:read"],
    };
    const site = makeSite({
      principals: new Map<string, Principal>([
        ["Bearer job", job],
        ["Bearer key", key],
      ]),
    });
    expect(
      (await (await connect(site, "Bearer job")).callTool({ name: "whoami", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ kind: "ci_job", repository_id: "repo-1", ci_run_id: "run-9" });
    expect(
      (await (await connect(site, "Bearer key")).callTool({ name: "whoami", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ kind: "api_key", scopes: ["git:read"], can_write: false });
    // Neither needed the API to say who it is.
    expect(site.apiCalls).toEqual([]);

    const readOnly = await siteWithToken(
      { api: apiOf({ "GET /api/session": { user: { username: "alice" } } }) },
      ["repo:read"],
    );
    const nameless = await siteWithToken({
      api: apiOf({ "GET /api/session": { user: { username: null, displayName: "New" } } }),
    });
    expect(
      (
        await (
          await connect(nameless.site, `Bearer ${nameless.token}`)
        ).callTool({ name: "whoami", arguments: {} })
      ).structuredContent,
    ).toMatchObject({ kind: "user", username: null, can_write: false, note: /username/ });
    const client = await connect(readOnly.site, `Bearer ${readOnly.token}`);
    expect(
      (await client.callTool({ name: "whoami", arguments: {} })).structuredContent,
    ).toMatchObject({ kind: "user", scopes: ["repo:read"], can_write: false });
  });

  it("list_my_branches reads the inbox", async () => {
    const inbox = {
      items: [{ repository: { owner: "acme", name: "infra" }, number: 7, branch: "feature" }],
      nextCursor: "next",
    };
    const { call, sent } = await setup({ "GET /api/review/inbox": inbox });
    const result = await call("list_my_branches", { limit: 5, cursor: "abc" });
    expect(result.structuredContent).toEqual(inbox);
    expect(sent()).toEqual(["GET /api/review/inbox?limit=5&cursor=abc"]);
  });

  it("get_branch finds the branch's pull request and reads its page", async () => {
    const { call, sent } = await setup({
      [`GET ${REPO}/pulls`]: PULLS,
      [`GET ${REPO}/pulls/7`]: {
        number: 7,
        title: "Add rate limits",
        body: "The ask",
        state: "open",
        draft: true,
        baseRef: "main",
        headRef: "feature",
        headOid: "a".repeat(40),
        mergeability: { state: "clean", blockers: [] },
        viewer: { canMerge: true },
      },
      [`GET ${REPO}/pulls/7/branch-state`]: { state: "agent_working", openInstructions: 2 },
      [`GET ${REPO}/pulls/7/versions`]: {
        branch: "feature",
        versions: [{ number: 1 }, { number: 2 }],
        latest: 2,
      },
    });
    const result = await call("get_branch", { repository: "acme/infra", branch: "feature" });
    expect(result.structuredContent).toEqual({
      url: `${ORIGIN}/acme/infra/pulls/7`,
      // What an agent needs of the pull request, not the page's whole view.
      pullRequest: {
        number: 7,
        title: "Add rate limits",
        body: "The ask",
        state: "open",
        draft: true,
        baseRef: "main",
        headRef: "feature",
        headOid: "a".repeat(40),
      },
      state: { state: "agent_working", openInstructions: 2 },
      versions: [{ number: 1 }, { number: 2 }],
      latestVersion: 2,
    });
    expect(sent()[0]).toBe(`GET ${REPO}/pulls?head=feature&state=open&limit=1`);
    expect(sent().slice(1).sort()).toEqual([
      `GET ${REPO}/pulls/7`,
      `GET ${REPO}/pulls/7/branch-state`,
      `GET ${REPO}/pulls/7/versions`,
    ]);
  });

  it("looks a merged branch up too, and says so when there is no page yet", async () => {
    const merged = await setup({
      [`GET ${REPO}/pulls`]: (request: Request) =>
        new URL(request.url).searchParams.get("state") === "all" ? PULLS : { items: [] },
      [`GET ${REPO}/pulls/7/findings`]: { findings: [], tally: { open: 0 } },
    });
    const found = await merged.call("list_findings", {
      repository: "acme/infra",
      branch: "feature",
    });
    expect(found.structuredContent).toMatchObject({ pull_request: 7 });

    const none = await setup({ [`GET ${REPO}/pulls`]: { items: [] } });
    const missing = await none.call("get_branch", { repository: "acme/infra", branch: "feature" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("has no pull request yet");
    expect(textOf(missing)).toContain("start_work");
    const neither = await none.call("get_branch", { repository: "acme/infra" });
    expect(textOf(neither)).toContain("Give `pull_request` or `branch`");
  });

  it("get_version_diff maps its modes onto the diff's `from`", async () => {
    const diff = { files: [], nextCursor: null, exact: true };
    const { call, sent } = await setup({
      [`GET ${REPO}/pulls/7/versions/latest/diff`]: diff,
      [`GET ${REPO}/pulls/7/versions/3/diff`]: diff,
    });
    const base = { repository: "acme/infra", pull_request: 7 };
    expect((await call("get_version_diff", base)).structuredContent).toEqual(diff);
    await call("get_version_diff", { ...base, version: 3, mode: "step", path: "src/a.ts" });
    await call("get_version_diff", { ...base, version: 3, mode: "since", since_version: 1 });
    expect(sent()).toEqual([
      `GET ${REPO}/pulls/7/versions/latest/diff?from=base`,
      `GET ${REPO}/pulls/7/versions/3/diff?from=previous&path=src%2Fa.ts`,
      `GET ${REPO}/pulls/7/versions/3/diff?from=1`,
    ]);
    const incomplete = await call("get_version_diff", { ...base, mode: "since" });
    expect(textOf(incomplete)).toContain("since_version");
  });

  it("record_trace sends the entries as the API takes them and answers what was kept", async () => {
    let received: any;
    const { call, sent } = await setup({
      [`POST ${REPO}/traces`]: async (request: Request) => {
        received = await request.json();
        return {
          entries: received.entries.map((entry: any, i: number) => ({ id: `e${i}`, ...entry })),
        };
      },
    });
    const result = await call("record_trace", {
      repository: "https://git.example.test/acme/infra.git",
      branch: "refs/heads/feature",
      session: "thread-42",
      entries: [
        { kind: "ask", body: "Add rate limits" },
        {
          kind: "decision",
          body: "Count by principal",
          anchors: [{ path: "src/http/admission.ts", start_line: 10, end_line: 20 }],
        },
        {
          kind: "evidence",
          body: "The suite passes",
          evidence: { command: "pnpm test", exit_code: 0, output: "42 passed", ci_run_id: "run-1" },
        },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(sent()).toEqual([`POST ${REPO}/traces`]);
    expect(received).toEqual({
      branch: "feature",
      // The client's own name, since the agent gave none.
      agent: { kind: "mcp", name: "test-agent", sessionRef: "thread-42" },
      entries: [
        { kind: "ask", body: "Add rate limits" },
        {
          kind: "decision",
          body: "Count by principal",
          anchors: [{ path: "src/http/admission.ts", startLine: 10, endLine: 20 }],
        },
        {
          kind: "evidence",
          body: "The suite passes",
          evidence: { command: "pnpm test", exitCode: 0, output: "42 passed", ciRunId: "run-1" },
        },
      ],
    });
    expect(result.structuredContent).toMatchObject({ recorded: 3, branch: "feature" });
    expect((result.structuredContent as any).next).toContain("next push");

    await call("record_trace", {
      repository: "acme/infra",
      branch: "feature",
      agent_name: "Codex",
      entries: [{ kind: "step", body: "did it" }],
    });
    expect(received.agent).toEqual({ kind: "mcp", name: "Codex" });
  });

  it("the instruction tools list what is open and mark it", async () => {
    const instructions = [
      { id: "i1", status: "queued", body: "Rename it" },
      { id: "i2", status: "delivered", body: "Add a test" },
      { id: "i3", status: "answered", body: "Done before" },
    ];
    const bodies: unknown[] = [];
    const marked = async (request: Request) => {
      bodies.push(await request.json());
      return { id: "i1", status: "delivered" };
    };
    const { call, sent } = await setup({
      [`GET ${REPO}/pulls/7/instructions`]: { instructions },
      [`PUT ${REPO}/pulls/7/instructions/i1/delivered`]: marked,
      [`PUT ${REPO}/pulls/7/instructions/i1/answered`]: marked,
    });
    const base = { repository: "acme/infra", pull_request: 7 };
    const open = await call("list_instructions", base);
    expect(open.structuredContent).toEqual({
      pull_request: 7,
      instructions: instructions.slice(0, 2),
    });
    expect((await call("list_instructions", { ...base, status: "all" })).structuredContent).toEqual(
      {
        pull_request: 7,
        instructions,
      },
    );
    await call("list_instructions", { ...base, status: "answered" });
    expect(
      (await call("mark_instruction_delivered", { ...base, instruction_id: "i1" }))
        .structuredContent,
    ).toEqual({ instruction: { id: "i1", status: "delivered" } });
    await call("mark_instruction_answered", { ...base, instruction_id: "i1" });
    await call("mark_instruction_answered", { ...base, instruction_id: "i1", version: 4 });
    expect(sent()).toEqual([
      `GET ${REPO}/pulls/7/instructions`,
      `GET ${REPO}/pulls/7/instructions`,
      `GET ${REPO}/pulls/7/instructions?status=answered`,
      `PUT ${REPO}/pulls/7/instructions/i1/delivered`,
      `PUT ${REPO}/pulls/7/instructions/i1/answered`,
      `PUT ${REPO}/pulls/7/instructions/i1/answered`,
    ]);
    expect(bodies).toEqual([{ via: "mcp" }, {}, { version: 4 }]);
  });

  it("list_findings and report_finding speak the findings API", async () => {
    let reported: any;
    const finding = { id: "f1", severity: "must_fix", title: "Unbounded read" };
    const { call, sent } = await setup({
      [`GET ${REPO}/pulls/7/findings`]: {
        findings: [finding],
        tally: { found: 1, mustFixOpen: 1 },
      },
      [`POST ${REPO}/pulls/7/findings`]: async (request: Request) => {
        reported = await request.json();
        return { findings: [finding] };
      },
    });
    const base = { repository: "acme/infra", pull_request: 7 };
    expect(
      (await call("list_findings", { ...base, status: "open", version: 2 })).structuredContent,
    ).toEqual({ pull_request: 7, findings: [finding], tally: { found: 1, mustFixOpen: 1 } });
    const result = await call("report_finding", {
      ...base,
      reviewer: "security",
      version: 2,
      complete: true,
      findings: [
        {
          severity: "must_fix",
          title: "Unbounded read",
          body: "The body is read whole.",
          path: "src/http.ts",
          start_line: 12,
          end_line: 14,
          evidence: [{ kind: "code", text: "await request.text()" }],
        },
      ],
    });
    expect(result.structuredContent).toEqual({ pull_request: 7, findings: [finding] });
    expect(reported).toEqual({
      reviewerKind: "security",
      version: 2,
      complete: true,
      findings: [
        {
          severity: "must_fix",
          title: "Unbounded read",
          body: "The body is read whole.",
          path: "src/http.ts",
          startLine: 12,
          endLine: 14,
          evidence: [{ kind: "code", text: "await request.text()" }],
        },
      ],
    });
    expect(sent()).toEqual([
      `GET ${REPO}/pulls/7/findings?status=open&version=2`,
      `POST ${REPO}/pulls/7/findings`,
    ]);
  });

  it("start_work makes the branch and its page, and says what to do next", async () => {
    let asked: any;
    const { call } = await setup({
      [`POST ${REPO}/work`]: async (request: Request) => {
        asked = await request.json();
        return { pullRequest: { number: 12 }, branch: "add-rate-limits", agent: { kind: "mcp" } };
      },
    });
    const result = await call("start_work", {
      repository: "acme/infra",
      ask: "Add rate limits to the API",
      base: "main",
      session: "thread-42",
    });
    expect(asked).toEqual({
      ask: "Add rate limits to the API",
      base: "main",
      agent: { kind: "mcp", displayName: "test-agent", externalRefs: { session: "thread-42" } },
    });
    expect(result.structuredContent).toMatchObject({
      branch: "add-rate-limits",
      pull_request: 12,
      url: `${ORIGIN}/acme/infra/pulls/12`,
    });
    expect((result.structuredContent as any).next).toContain("git switch add-rate-limits");
  });

  it("says so when a part of the forge is not built on this server", async () => {
    const unbuilt = Response.json(
      { error: "Reading instructions is not available yet", code: "not_implemented" },
      { status: 503 },
    );
    const { call } = await setup({
      [`GET ${REPO}/pulls/7/instructions`]: () => unbuilt.clone(),
      [`POST ${REPO}/pulls/7/findings`]: () => unbuilt.clone(),
    });
    const base = { repository: "acme/infra", pull_request: 7 };
    for (const result of [
      await call("list_instructions", base),
      await call("report_finding", { ...base, reviewer: "general", findings: [] }),
    ]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(textOf(result)).toContain("not available on this server yet");
      expect(textOf(result)).toContain("Nothing was changed");
    }
  });

  it("passes the forge's refusals on in words", async () => {
    const refusal =
      (status: number, body: unknown, headers: Record<string, string> = {}) =>
      () =>
        Response.json(body, { status, headers });
    const { call } = await setup({
      [`POST ${REPO}/traces`]: refusal(403, {
        error: "Recording a trace needs write access to the repository",
      }),
      [`GET ${REPO}/pulls/7/findings`]: refusal(404, { error: "Repository not found" }),
      [`GET ${REPO}/pulls/7/instructions`]: refusal(
        429,
        { error: "Too many requests" },
        { "retry-after": "17" },
      ),
      [`POST ${REPO}/work`]: refusal(409, {
        error: "A branch of that name exists",
        code: "ref_exists",
      }),
      [`GET /api/review/inbox`]: refusal(401, { error: "That credential was not accepted" }),
      [`GET ${REPO}/pulls/7/versions/latest/diff`]: () =>
        new Response("upstream fell over", { status: 500 }),
    });
    const base = { repository: "acme/infra", pull_request: 7 };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "record_trace",
        { repository: "acme/infra", branch: "f", entries: [{ kind: "step", body: "b" }] },
        "needs write access",
      ],
      ["list_findings", base, "cannot read it"],
      ["list_instructions", base, "Wait 17 seconds"],
      ["start_work", { repository: "acme/infra", ask: "x" }, "(ref_exists)"],
      ["list_my_branches", {}, "Sign in again"],
      ["get_version_diff", base, "the forge answered 500"],
    ];
    for (const [name, args, expected] of cases) {
      const result = await call(name, args);
      expect([name, result.isError]).toEqual([name, true]);
      expect(textOf(result)).toContain(expected);
    }
    const bad = await call("get_branch", { repository: "not-a-repository", pull_request: 1 });
    expect(textOf(bad)).toContain("owner/name");
  });

  it("reads a repository from a name, a clone URL or a page", () => {
    for (const value of [
      "acme/infra",
      "/acme/infra",
      "acme/infra.git",
      `${ORIGIN}/acme/infra`,
      `${ORIGIN}/acme/infra.git`,
      "https://git.infrawrench.com/acme/infra/pulls/7",
      "git@git.infrawrench.com:acme/infra.git",
    ]) {
      expect([value, repositoryPath(value, ORIGIN)]).toEqual([value, REPO]);
    }
    expect(repositoryPath("a b/c d", ORIGIN)).toBe("/api/repos/a%20b/c%20d");
    for (const value of ["acme", "", "/", 7]) {
      expect(() => repositoryPath(value, ORIGIN)).toThrow("owner/name");
    }
  });
});

describe("a client signing in with OAuth", () => {
  /** The storage an MCP client keeps, and the browser it would open. */
  const provider = (site: Site, userId: string, decision: "allow" | "deny" = "allow") => {
    const state: {
      client?: any;
      tokens?: any;
      verifier?: string;
      discovery?: any;
      back?: URL;
      authorizationUrl?: URL;
    } = {};
    const oauth: OAuthClientProvider = {
      get redirectUrl() {
        return "http://127.0.0.1:43110/callback";
      },
      get clientMetadata() {
        return {
          client_name: "Example Agent",
          redirect_uris: ["http://127.0.0.1:43110/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      clientInformation: () => state.client,
      saveClientInformation: (client) => void (state.client = client),
      tokens: () => state.tokens,
      saveTokens: (tokens) => void (state.tokens = tokens),
      saveCodeVerifier: (verifier) => void (state.verifier = verifier),
      codeVerifier: () => state.verifier!,
      saveDiscoveryState: (discovery) => void (state.discovery = discovery),
      discoveryState: () => state.discovery,
      invalidateCredentials(scope) {
        if (scope === "all" || scope === "tokens") state.tokens = undefined;
        if (scope === "all" || scope === "client") state.client = undefined;
        if (scope === "all" || scope === "verifier") delete state.verifier;
        if (scope === "all" || scope === "discovery") state.discovery = undefined;
      },
      async redirectToAuthorization(url) {
        state.authorizationUrl = url;
        state.back = await browse(site, url, userId, decision);
      },
    };
    return { oauth, state };
  };
  const transportOf = (site: Site, oauth: OAuthClientProvider) =>
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (input, init) => site.fetch(input as string | URL, init),
      authProvider: oauth,
    });

  it("discovers, registers, proves itself with PKCE, and calls a tool as the person", async () => {
    let now = Date.now();
    const site = makeSite({
      now: () => now,
      api: apiOf({ "GET /api/session": { user: { username: "alice" } } }),
    });
    const { oauth, state } = provider(site, "alice");

    // The first connection is refused, and the client sends the browser off.
    const first = transportOf(site, oauth);
    await expect(
      new Client({ name: "example", version: "1" }).connect(first),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(state.client.client_id).toMatch(/^iwc_/);
    const asked = state.authorizationUrl!;
    expect(asked.origin + asked.pathname).toBe(`${ORIGIN}/oauth/authorize`);
    expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
    expect(asked.searchParams.get("resource")).toBe(`${ORIGIN}/mcp`);
    expect(state.back!.searchParams.get("iss")).toBe(ORIGIN);

    // The browser came back with a code; the client exchanges it and connects.
    await first.finishAuth(state.back!.searchParams);
    expect(state.tokens.access_token).toMatch(/^iwg_/);
    expect(state.tokens.refresh_token).toMatch(/^iwr_/);
    const client = new Client({ name: "example", version: "1" });
    await client.connect(transportOf(site, oauth));
    const who = await client.callTool({ name: "whoami", arguments: {} });
    expect(who.structuredContent).toMatchObject({
      kind: "user",
      username: "alice",
      scopes: ["repo:read", "repo:write"],
    });
    expect([...site.store.rows.values()]).toMatchObject([
      { userId: "alice", name: "Example Agent (MCP)", revokedAt: null },
    ]);

    // An hour on the access token has expired: the client refreshes by itself.
    const before = state.tokens.access_token;
    now += OAUTH_LIFETIMES.accessTokenSeconds * 1000 + 1;
    const again = new Client({ name: "example", version: "1" });
    await again.connect(transportOf(site, oauth));
    expect((await again.callTool({ name: "whoami", arguments: {} })).isError).toBeFalsy();
    expect(state.tokens.access_token).not.toBe(before);
    expect(site.store.rows.size).toBe(1);

    // The person revokes it from their settings: the client is signed out.
    for (const row of site.store.rows.values()) await site.store.revoke(row.id);
    const denied = provider(site, "alice", "deny");
    denied.state.client = state.client;
    denied.state.tokens = state.tokens;
    await expect(
      new Client({ name: "example", version: "1" }).connect(transportOf(site, denied.oauth)),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    // It asked again, and this time the person said no.
    expect(denied.state.back!.searchParams.get("error")).toBe("access_denied");
  });
});
