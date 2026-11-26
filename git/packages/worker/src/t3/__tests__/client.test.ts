/**
 * The forge as a client of a T3 Code environment, against a fake one
 * (`helpers/fake-t3.ts`): which addresses it will call at all, OAuth
 * discovery, registration and PKCE, and MCP over Streamable HTTP. No
 * database: storing a sign-in is the database suite's.
 */
import { describe, expect, it } from "vitest";
import { type FakeT3, fakeT3 } from "../../__tests__/helpers/fake-t3";
import {
  LOCALHOST_REFUSAL,
  T3Error,
  T3_HTTP_LIMITS,
  environmentOrigin,
  makeT3Http,
  publicHttpsUrl,
} from "../http";
import { McpClient, responseOf, toolResult } from "../mcp";
import {
  authorizationServerMetadataUrls,
  authorizeUrl,
  discover,
  exchangeCode,
  parseChallenge,
  pkceChallenge,
  randomToken,
  refreshTokens,
  registerClient,
  revokeToken,
} from "../oauth";
import { remoteKey, workPrompt } from "../work";

const SITE = ["git.example.test"];
const REDIRECT = "https://git.example.test/auth/t3/callback";

const httpOf = (fetch: (input: string, init: RequestInit) => Promise<Response>) =>
  makeT3Http({ fetch, siteHosts: SITE });

const refusal = async (work: () => unknown): Promise<T3Error> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof T3Error) return error;
    throw error;
  }
  throw new Error("was not refused");
};

/** Sign in to the fake the way the forge does, and answer a token for it. */
const signIn = async (t3: FakeT3) => {
  const http = httpOf(t3.fetch);
  const found = await discover(http, t3.origin, SITE);
  const client = await registerClient(http, found.endpoints, { redirectUri: REDIRECT });
  const verifier = randomToken();
  const url = authorizeUrl(found.endpoints, {
    clientId: client.clientId,
    redirectUri: REDIRECT,
    state: "state-1",
    challenge: await pkceChallenge(verifier),
    resource: found.resource,
    scopes: found.scopes,
  });
  const back = t3.approve(url);
  const tokens = await exchangeCode(http, found.endpoints, client, {
    code: back.code,
    verifier,
    redirectUri: REDIRECT,
    resource: found.resource,
  });
  return { http, found, client, tokens, verifier, url, back };
};

describe("which addresses the forge will call", () => {
  it("takes a public https address and keeps its origin", () => {
    expect(environmentOrigin("https://t3.example.net/mcp", SITE)).toBe("https://t3.example.net");
    expect(environmentOrigin("  t3.example.net:8443/  ", SITE)).toBe("https://t3.example.net:8443");
  });

  it("says why localhost cannot be reached", async () => {
    for (const address of [
      "http://localhost:3773",
      "https://localhost",
      "http://127.0.0.1:3773/mcp",
      "https://[::1]:3773",
      "https://dev.localhost",
    ]) {
      const error = await refusal(() => environmentOrigin(address, SITE));
      expect(error.code).toBe("address_refused");
      expect(error.message).toBe(LOCALHOST_REFUSAL);
    }
  });

  it("refuses everything that is not https to a public address", async () => {
    for (const address of [
      "http://t3.example.net",
      "ftp://t3.example.net",
      "https://10.0.0.5",
      "https://192.168.1.20:3773",
      "https://172.16.0.1",
      "https://169.254.169.254/latest/meta-data",
      "https://100.100.1.2",
      "https://[fd00::1]",
      "https://[fe80::1]",
      "https://[::ffff:10.0.0.1]",
      "https://0.0.0.0",
      "https://intranet",
      "https://box.local",
      "https://db.internal",
      "https://user:secret@t3.example.net",
      "https://git.example.test",
      "not a url at all",
    ]) {
      expect((await refusal(() => publicHttpsUrl(address, SITE))).code, address).toBe(
        "address_refused",
      );
    }
  });

  it("never follows a redirect, wherever it points", async () => {
    const seen: string[] = [];
    const http = httpOf(async (input) => {
      seen.push(input);
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    });
    const error = await refusal(() => http("https://t3.example.net/mcp"));
    expect(error.code).toBe("bad_answer");
    expect(seen).toEqual(["https://t3.example.net/mcp"]);
  });

  it("asks with redirects off, a timeout, and nothing of the reader's", async () => {
    let init: RequestInit | undefined;
    const http = httpOf(async (_input, given) => {
      init = given;
      return new Response("{}", { status: 200 });
    });
    await http("https://t3.example.net/x", { headers: { authorization: "Bearer t" } });
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual(["authorization", "user-agent"]);
    expect(headers.get("cookie")).toBeNull();
  });

  it("refuses an answer past the size cap, declared or not", async () => {
    const big = "x".repeat(T3_HTTP_LIMITS.maxBytes + 1);
    const declared = httpOf(
      async () => new Response("small", { headers: { "content-length": String(big.length) } }),
    );
    expect((await refusal(() => declared("https://t3.example.net/x"))).code).toBe("bad_answer");
    const streamed = httpOf(async () => new Response(big));
    expect((await refusal(() => streamed("https://t3.example.net/x"))).code).toBe("bad_answer");
  });

  it("reports an environment that does not answer without the cause", async () => {
    const http = httpOf(async () => {
      throw new TypeError("connect ECONNREFUSED 10.1.2.3:443 with Bearer abcdefghijkl");
    });
    const error = await refusal(() => http("https://t3.example.net/x"));
    expect(error.code).toBe("unreachable");
    expect(error.message).toBe("The environment did not answer");
  });
});

describe("OAuth with a T3 Code environment", () => {
  it("discovers the authorization server from the resource's metadata", async () => {
    const t3 = fakeT3();
    const found = await discover(httpOf(t3.fetch), t3.origin, SITE);
    expect(found).toEqual({
      endpoints: {
        issuer: t3.origin,
        authorizationEndpoint: `${t3.origin}/oauth/mcp/authorize`,
        tokenEndpoint: `${t3.origin}/oauth/mcp/token`,
        registrationEndpoint: `${t3.origin}/oauth/mcp/register`,
      },
      resource: `${t3.origin}/mcp`,
      scopes: ["orchestration:read", "orchestration:operate"],
    });
    // The probe that finds the challenge carries no credential.
    expect(t3.requests[0]).toMatchObject({ method: "POST", url: `${t3.origin}/mcp` });
    expect(t3.requests[0]!.headers["authorization"]).toBeUndefined();
  });

  it("reads a challenge, and the well-known addresses in the specification's order", () => {
    expect(
      parseChallenge(
        'Bearer resource_metadata="https://a.example/.well-known/oauth-protected-resource/mcp", scope="a b", error="invalid_token"',
      ),
    ).toEqual({
      resourceMetadata: "https://a.example/.well-known/oauth-protected-resource/mcp",
      scope: "a b",
    });
    expect(parseChallenge("Basic realm=x")).toEqual({});
    expect(parseChallenge(null)).toEqual({});
    expect(authorizationServerMetadataUrls(new URL("https://auth.example"))).toEqual([
      "https://auth.example/.well-known/oauth-authorization-server",
      "https://auth.example/.well-known/openid-configuration",
    ]);
    expect(authorizationServerMetadataUrls(new URL("https://auth.example/tenant1"))).toEqual([
      "https://auth.example/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example/.well-known/openid-configuration/tenant1",
      "https://auth.example/tenant1/.well-known/openid-configuration",
    ]);
  });

  it("refuses metadata that points at a private address, at any step", async () => {
    const t3 = fakeT3();
    const rewrite =
      (path: string, change: (body: Record<string, unknown>) => void) =>
      async (input: string, init: RequestInit) => {
        const response = await t3.fetch(input, init);
        if (new URL(input).pathname !== path) return response;
        const body = (await response.json()) as Record<string, unknown>;
        change(body);
        return new Response(JSON.stringify(body), { status: 200 });
      };
    const cases: Array<[string, (body: Record<string, unknown>) => void]> = [
      [
        "/.well-known/oauth-protected-resource/mcp",
        (body) => (body["authorization_servers"] = ["https://10.0.0.1"]),
      ],
      [
        "/.well-known/oauth-protected-resource/mcp",
        (body) => (body["authorization_servers"] = ["http://auth.example.net"]),
      ],
      [
        "/.well-known/oauth-authorization-server",
        (body) => (body["token_endpoint"] = "https://169.254.169.254/token"),
      ],
      [
        "/.well-known/oauth-authorization-server",
        (body) => (body["authorization_endpoint"] = "javascript:alert(1)"),
      ],
      [
        "/.well-known/oauth-authorization-server",
        (body) => (body["registration_endpoint"] = "https://localhost/register"),
      ],
    ];
    for (const [path, change] of cases) {
      const error = await refusal(() => discover(httpOf(rewrite(path, change)), t3.origin, SITE));
      expect(error.code, path).toBe("address_refused");
    }
  });

  it("does not take the resource's metadata from another origin's address", async () => {
    const t3 = fakeT3();
    const asked: string[] = [];
    const http = httpOf(async (input, init) => {
      asked.push(input);
      const response = await t3.fetch(input, init);
      if (response.status !== 401) return response;
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://elsewhere.example.org/.well-known/oauth-protected-resource"',
        },
      });
    });
    await discover(http, t3.origin, SITE);
    expect(asked.some((url) => url.includes("elsewhere.example.org"))).toBe(false);
  });

  it("refuses a server without PKCE S256, and an address with no sign-in at all", async () => {
    const t3 = fakeT3();
    const noPkce = httpOf(async (input, init) => {
      const response = await t3.fetch(input, init);
      if (!input.endsWith("/oauth-authorization-server")) return response;
      const body = (await response.json()) as Record<string, unknown>;
      body["code_challenge_methods_supported"] = ["plain"];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    expect((await refusal(() => discover(noPkce, t3.origin, SITE))).code).toBe("unsupported");
    const nothing = httpOf(async () => new Response("not found", { status: 404 }));
    expect((await refusal(() => discover(nothing, "https://www.example.org", SITE))).code).toBe(
      "unsupported",
    );
  });

  it("registers as a public client with only the fields T3 Code reads", async () => {
    const t3 = fakeT3();
    const http = httpOf(t3.fetch);
    const found = await discover(http, t3.origin, SITE);
    const client = await registerClient(http, found.endpoints, { redirectUri: REDIRECT });
    expect(client.clientId).toMatch(/^client\.id-/);
    expect(client.clientSecret).toBeUndefined();
    expect(t3.registrations).toEqual([
      {
        client_name: "Infrawrench Git",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      },
    ]);
  });

  it("signs in with PKCE S256 and the resource indicator", async () => {
    const t3 = fakeT3();
    const { url, tokens, verifier } = await signIn(t3);
    const query = new URL(url).searchParams;
    expect(query.get("response_type")).toBe("code");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).toBe(await pkceChallenge(verifier));
    expect(query.get("code_challenge")).not.toBe(verifier);
    expect(query.get("resource")).toBe(`${t3.origin}/mcp`);
    expect(query.get("redirect_uri")).toBe(REDIRECT);
    expect(query.get("state")).toBe("state-1");
    expect(tokens.accessToken).toMatch(/^access\.token-/);
    // T3 Code issues no refresh token: thirty days, then the person signs in again.
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt!.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(tokens.scopes).toContain("orchestration:operate");
  });

  it("makes verifiers and states that are long, random and url-safe", async () => {
    const made = new Set(Array.from({ length: 50 }, randomToken));
    expect(made.size).toBe(50);
    for (const each of made) expect(each).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // RFC 7636, appendix B.
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("cannot redeem a code with the wrong verifier, or twice", async () => {
    const t3 = fakeT3();
    const http = httpOf(t3.fetch);
    const found = await discover(http, t3.origin, SITE);
    const client = await registerClient(http, found.endpoints, { redirectUri: REDIRECT });
    const verifier = randomToken();
    const authorize = async () =>
      t3.approve(
        authorizeUrl(found.endpoints, {
          clientId: client.clientId,
          redirectUri: REDIRECT,
          state: "s",
          challenge: await pkceChallenge(verifier),
          resource: found.resource,
          scopes: [],
        }),
      );
    const exchange = (code: string, with_: string) =>
      exchangeCode(http, found.endpoints, client, {
        code,
        verifier: with_,
        redirectUri: REDIRECT,
        resource: found.resource,
      });
    const first = await authorize();
    expect((await refusal(() => exchange(first.code, randomToken()))).code).toBe("not_signed_in");
    const second = await authorize();
    await exchange(second.code, verifier);
    expect((await refusal(() => exchange(second.code, verifier))).code).toBe("not_signed_in");
  });

  it("refreshes where the server rotates refresh tokens, and a spent one ends the sign-in", async () => {
    const t3 = fakeT3({ refresh: true, expiresIn: 3600 });
    const { http, found, client, tokens } = await signIn(t3);
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    const again = await refreshTokens(http, found.endpoints, client, {
      refreshToken: tokens.refreshToken!,
      resource: found.resource,
    });
    expect(again.accessToken).not.toBe(tokens.accessToken);
    expect(again.refreshToken).not.toBe(tokens.refreshToken);
    const error = await refusal(() =>
      refreshTokens(http, found.endpoints, client, {
        refreshToken: tokens.refreshToken!,
        resource: found.resource,
      }),
    );
    expect(error.code).toBe("not_signed_in");
  });

  it("revokes where there is an endpoint, and says when there is none", async () => {
    const t3 = fakeT3();
    const { http, found, client, tokens } = await signIn(t3);
    // T3 Code has no revocation endpoint: nothing is called.
    const before = t3.requests.length;
    expect(
      await revokeToken(http, found.endpoints, client, tokens.accessToken, "access_token"),
    ).toBe(false);
    expect(t3.requests.length).toBe(before);
    const posted: string[] = [];
    const withEndpoint = { ...found.endpoints, revocationEndpoint: `${t3.origin}/oauth/revoke` };
    const revoking = httpOf(async (input, init) => {
      posted.push(`${input} ${String(init.body)}`);
      return new Response(null, { status: 200 });
    });
    expect(await revokeToken(revoking, withEndpoint, client, "tok", "refresh_token")).toBe(true);
    expect(posted[0]).toContain("token=tok");
    expect(posted[0]).toContain("token_type_hint=refresh_token");
  });
});

describe("MCP over Streamable HTTP", () => {
  const clientOf = (t3: FakeT3, token: string) =>
    new McpClient({
      http: httpOf(t3.fetch),
      url: `${t3.origin}/mcp`,
      token: async () => token,
    });

  it("initializes, keeps the session, and calls a tool", async () => {
    const t3 = fakeT3();
    const { tokens } = await signIn(t3);
    t3.projects.push({
      id: "p1",
      title: "infra",
      workspaceRoot: "/w/infra",
      remoteUrl: "https://git.example.test/acme/infra.git",
    });
    const before = t3.requests.length;
    const client = clientOf(t3, tokens.accessToken);
    const listed = (await client.callTool("t3_project_list", { limit: 100 })) as {
      projects: Array<{ id: string }>;
    };
    expect(listed.projects.map((project) => project.id)).toEqual(["p1"]);
    await client.callTool("t3_project_list", {});

    const sent = t3.requests.slice(before);
    expect(sent.map((request) => (JSON.parse(request.body) as { method: string }).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    expect(JSON.parse(sent[0]!.body).params.protocolVersion).toBe("2025-11-25");
    expect(sent[0]!.headers["mcp-session-id"]).toBeUndefined();
    for (const request of sent) {
      expect(request.headers["authorization"]).toBe(`Bearer ${tokens.accessToken}`);
      expect(request.headers["accept"]).toBe("application/json, text/event-stream");
      // T3 Code answers 403 to anything with an Origin; a cookie is never the forge's to send.
      expect(request.headers["origin"]).toBeUndefined();
      expect(request.headers["cookie"]).toBeUndefined();
    }
    for (const request of sent.slice(1)) {
      expect(request.headers["mcp-session-id"]).toMatch(/^session-/);
      expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");
    }
  });

  it("starts a new session when the environment forgot the old one", async () => {
    const t3 = fakeT3();
    const { tokens } = await signIn(t3);
    const client = clientOf(t3, tokens.accessToken);
    await client.callTool("t3_project_list", {});
    t3.dropSessions();
    expect(await client.callTool("t3_project_list", {})).toMatchObject({ projects: [] });
  });

  it("reads an answer sent as an event stream", async () => {
    const t3 = fakeT3({ stream: true });
    const { tokens } = await signIn(t3);
    expect(await clientOf(t3, tokens.accessToken).callTool("t3_project_list", {})).toEqual({
      projects: [],
      nextCursor: null,
    });
  });

  it("turns a tool's refusal into its sentence and code", async () => {
    const t3 = fakeT3({ access: "read-only" });
    const { tokens } = await signIn(t3);
    const error = await refusal(() =>
      clientOf(t3, tokens.accessToken).callTool("t3_thread_launch", { projectId: "p", title: "t" }),
    );
    expect(error.code).toBe("forbidden");
    expect(error.toolCode).toBe("capability_denied");
    expect(error.message).toBe(
      "This tool changes the environment, and this MCP client was approved for read-only access.",
    );
    const unknown = await refusal(() =>
      clientOf(t3, tokens.accessToken).callTool("t3_project_list", { nope: true }),
    );
    expect(unknown.code).toBe("tool_failed");
    expect(unknown.message).toContain('Unknown argument "nope"');
  });

  it("says to sign in again when the token is not accepted", async () => {
    const t3 = fakeT3();
    const error = await refusal(() => clientOf(t3, "not.a-token").callTool("t3_project_list", {}));
    expect(error.code).toBe("not_signed_in");
    expect(error.status).toBe(401);
  });

  it("picks the response to its own request out of a stream, and refuses one without it", () => {
    const answer = (text: string, type: string) => ({
      status: 200,
      headers: new Headers({ "content-type": type }),
      text,
    });
    const stream = [
      "id: 1\ndata: \n",
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n',
      'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n',
    ].join("\n");
    expect(responseOf(answer(stream, "text/event-stream; charset=utf-8"), 7).result).toEqual({
      ok: true,
    });
    expect(() => responseOf(answer(stream, "text/event-stream"), 8)).toThrow(T3Error);
    expect(() => responseOf(answer("<html>", "text/html"), 1)).toThrow(T3Error);
  });

  it("reads a result's structured content, then its text", () => {
    expect(toolResult({ structuredContent: { a: 1 }, content: [] }, "t")).toEqual({ a: 1 });
    expect(toolResult({ content: [{ type: "text", text: '{"b":2}' }] }, "t")).toEqual({ b: 2 });
    expect(toolResult({ content: [{ type: "text", text: "plain" }] }, "t")).toBe("plain");
    expect(() =>
      toolResult(
        { isError: true, content: [{ type: "text", text: "Tool execution failed." }] },
        "t",
      ),
    ).toThrow("Tool execution failed.");
  });
});

describe("what a T3 Code thread is told", () => {
  it("matches a project by its remote, however the remote is written", () => {
    for (const remote of [
      "https://git.example.test/Acme/infra.git",
      "https://someone:token@git.example.test/acme/infra",
      "git@git.example.test:acme/infra.git",
      "ssh://git@git.example.test/acme/infra.git",
    ]) {
      expect(remoteKey(remote), remote).toBe("git.example.test/acme/infra");
    }
    expect(remoteKey("/Users/someone/code/infra")).toBeNull();
    expect(remoteKey("")).toBeNull();
  });

  it("writes the ask, the branch to push to and how to report, and no credential", () => {
    const prompt = workPrompt(
      {
        repository: { owner: "acme", name: "infra" },
        pullRequestId: "pr-1",
        number: 14,
        title: "Add rate limits",
        ask: "Add rate limits to the API.\n\nPer key, 100 a minute.",
        branch: "work/add-rate-limits",
        baseRef: "main",
      },
      "https://git.example.test",
    );
    expect(prompt).toContain("acme/infra on git.example.test, pull request #14: Add rate limits");
    expect(prompt).toContain("https://git.example.test/acme/infra/pulls/14");
    expect(prompt).toContain("Per key, 100 a minute.");
    expect(prompt).toContain("git push -u origin work/add-rate-limits");
    expect(prompt).toContain(
      "claude mcp add --transport http infrawrench-git https://git.example.test/mcp",
    );
    expect(prompt).toContain("Git credentials this machine already has");
    expect(prompt).not.toMatch(/iw[gjk]_|Bearer|token=/);
    expect(prompt).not.toContain("—");
  });
});
