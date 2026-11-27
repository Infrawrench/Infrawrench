/**
 * The authorization server MCP clients sign in through: discovery,
 * registration (dynamic, and by metadata document), the consent page, PKCE,
 * the token endpoint, refresh rotation and revocation. Driven over the
 * site's `fetch` (`harness.ts`), as a client and a browser would.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { seal } from "../../auth/session-cookie";
import { mintAccessToken } from "../../auth/tokens";
import { forgetClientDocuments, parseRedirectUri, redirectMatches } from "../oauth/clients";
import { challengeOf } from "../oauth/grants";
import { isOurResource } from "../oauth/metadata";
import { OAUTH_LIFETIMES, grantLapsesAt, parseScopes } from "../oauth/protocol";
import { sealAs, unsealAs } from "../oauth/sealed";
import { ORIGIN, PASSWORD, type Site, browse, consentRequestOf, makeSite } from "./harness";

const REDIRECT = "http://127.0.0.1:43110/callback";
const VERIFIER = "v".repeat(20) + "E".repeat(20) + "7".repeat(20);

const json = async (response: Response): Promise<any> => response.json();

const register = async (site: Site, metadata: Record<string, unknown> = {}) =>
  site.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Agent",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...metadata,
    }),
  });

const authorizeUrl = async (clientId: string, overrides: Record<string, string | null> = {}) => {
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  const parameters: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await challengeOf(VERIFIER),
    code_challenge_method: "S256",
    state: "state-123",
    scope: "repo:read repo:write",
    resource: `${ORIGIN}/mcp`,
    ...overrides,
  };
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url;
};

const token = (site: Site, parameters: Record<string, string>) =>
  site.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
  });

/** Register, consent as `userId` and exchange the code: a client's whole first sign-in. */
const signIn = async (site: Site, userId = "alice") => {
  const clientId: string = (await json(await register(site))).client_id;
  const back = await browse(site, await authorizeUrl(clientId), userId);
  const code = back.searchParams.get("code")!;
  const answer = await token(site, {
    grant_type: "authorization_code",
    code,
    code_verifier: VERIFIER,
    client_id: clientId,
    redirect_uri: REDIRECT,
    resource: `${ORIGIN}/mcp`,
  });
  return { clientId, code, answer, tokens: await json(answer.clone()) };
};

const callMcp = (site: Site, accessToken: string) =>
  site.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });

beforeEach(() => forgetClientDocuments());

describe("discovery", () => {
  it("says where the authorization server is, at both well-known paths", async () => {
    const site = makeSite();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await site.fetch(`${ORIGIN}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await json(response)).toMatchObject({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
        scopes_supported: ["repo:read", "repo:write"],
        bearer_methods_supported: ["header"],
      });
    }
  });

  it("describes the authorization server as the MCP specification needs it", async () => {
    const site = makeSite();
    const response = await site.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(await json(response)).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      scopes_supported: ["repo:read", "repo:write"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("answers JSON, never a page, for anything else under /.well-known", async () => {
    const site = makeSite();
    const response = await site.fetch(`${ORIGIN}/.well-known/openid-configuration`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const preflight = await site.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`, {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
  });
});

describe("registration", () => {
  it("answers a client id that carries the registration, and stores nothing", async () => {
    const site = makeSite();
    const response = await register(site, { token_endpoint_auth_method: "client_secret_basic" });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body).toMatchObject({
      client_name: "Test Agent",
      redirect_uris: [REDIRECT],
      // Whatever was asked for, the client is public.
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(body.client_id).toMatch(/^iwc_/);
    expect(body.client_secret).toBeUndefined();
    expect(site.store.rows.size).toBe(0);
  });

  it.each([
    ["none at all", []],
    ["plain http elsewhere", ["http://example.com/callback"]],
    ["a fragment", ["https://example.com/callback#x"]],
    ["credentials", ["https://user:pass@example.com/callback"]],
    ["a script", ["javascript:alert(1)"]],
    ["a data address", ["data:text/html,hi"]],
    ["this site", [`${ORIGIN}/acme/infra`]],
    ["not an address", ["callback"]],
    ["too many", Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`)],
  ])("refuses redirect URIs with %s", async (_name, uris) => {
    const response = await register(makeSite(), { redirect_uris: uris });
    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe("invalid_redirect_uri");
  });

  it("takes https, loopback http and an app's own scheme", () => {
    expect(parseRedirectUri("https://claude.ai/api/mcp/auth_callback")).not.toBeNull();
    expect(parseRedirectUri("http://localhost:3334/oauth/callback")).not.toBeNull();
    expect(parseRedirectUri("http://[::1]:9000/cb")).not.toBeNull();
    expect(parseRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).not.toBeNull();
    expect(parseRedirectUri("http://localhost.example.com/cb")).toBeNull();
    expect(parseRedirectUri("http://192.168.1.4/cb")).toBeNull();
    expect(parseRedirectUri("https://example.com/cb\n")).toBeNull();
  });

  it("matches a loopback redirect on any port, and nothing else loosely", () => {
    expect(redirectMatches(REDIRECT, "http://127.0.0.1:51000/callback")).toBe(true);
    expect(redirectMatches(REDIRECT, "http://127.0.0.1:51000/other")).toBe(false);
    expect(redirectMatches(REDIRECT, "http://localhost:43110/callback")).toBe(false);
    expect(redirectMatches("https://a.example/cb", "https://a.example:8443/cb")).toBe(false);
    expect(redirectMatches("https://a.example/cb", "https://a.example/cb?x=1")).toBe(false);
    expect(redirectMatches("https://a.example/cb", "https://a.example/cb")).toBe(true);
  });

  it("does not know a client id it did not make", async () => {
    const site = makeSite();
    const clientId: string = (await json(await register(site))).client_id;
    const forged = `iwc_${await seal({ n: "Evil", r: ["https://evil.example/cb"], t: 0 }, "another-password-of-at-least-thirty-two-chars")}`;
    // Sealed by us, for another purpose: not a client either.
    const refresh = `iwc_${await sealAs("refresh", { n: "Evil", r: ["https://evil.example/cb"], t: 0 }, PASSWORD)}`;
    for (const id of [forged, refresh, `${clientId}x`, "iwc_", "nobody"]) {
      const response = await site.fetch(
        await authorizeUrl(id, { redirect_uri: "https://evil.example/cb" }),
        { headers: { cookie: "session=alice" }, redirect: "manual" },
      );
      // A page, not a redirect: nothing is sent to an address we do not know.
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });
});

describe("a client id that is a metadata document", () => {
  const CLIENT = "https://agent.example/oauth/client.json";
  const documents = (body: unknown, init: ResponseInit = {}) => {
    const fetched: string[] = [];
    return {
      fetched,
      fetch: async (url: string, request: RequestInit) => {
        fetched.push(url);
        expect(request.redirect).toBe("manual");
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
          ...init,
        });
      },
    };
  };
  const good = { client_id: CLIENT, client_name: "Agent Co", redirect_uris: [REDIRECT] };
  const show = (site: Site, clientId = CLIENT) =>
    authorizeUrl(clientId).then((url) =>
      site.fetch(url, { headers: { cookie: "session=alice" }, redirect: "manual" }),
    );

  it("is fetched, shown by name and address, and kept for the next request", async () => {
    const source = documents(good);
    const site = makeSite({ documents: source.fetch });
    const page = await show(site);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Agent Co wants access to git.example.test");
    expect(html).toContain(CLIENT);
    await show(site);
    expect(source.fetched).toEqual([CLIENT]);
  });

  it("signs a client in end to end", async () => {
    const site = makeSite({ documents: documents(good).fetch });
    const back = await browse(site, await authorizeUrl(CLIENT), "alice");
    const answer = await token(site, {
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: VERIFIER,
      client_id: CLIENT,
    });
    expect(answer.status).toBe(200);
    expect([...site.store.rows.values()][0]!.name).toBe("Agent Co (MCP)");
  });

  it.each([
    ["names another client", { ...good, client_id: "https://agent.example/other.json" }],
    ["has no name", { client_id: CLIENT, redirect_uris: [REDIRECT] }],
    ["has no redirect URIs", { client_id: CLIENT, client_name: "Agent Co" }],
    ["wants a client secret", { ...good, token_endpoint_auth_method: "client_secret_post" }],
    ["is not an object", [good]],
    ["is not JSON", "<html>"],
  ])("is refused when the document %s", async (_name, body) => {
    const page = await show(makeSite({ documents: documents(body).fetch }));
    expect(page.status).toBe(400);
  });

  it("is refused when the address does not answer 200, or answers too much", async () => {
    for (const source of [
      documents(good, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      documents(good, { status: 404 }),
      documents({ ...good, padding: "x".repeat(70_000) }),
    ]) {
      expect((await show(makeSite({ documents: source.fetch }))).status).toBe(400);
    }
  });

  it.each([
    "http://agent.example/client.json",
    "https://agent.example/",
    "https://agent.example",
    "https://user:pass@agent.example/client.json",
    "https://127.0.0.1/client.json",
    "https://10.0.0.8/client.json",
    "https://[::1]/client.json",
    "https://metadata.internal/client.json",
    "https://localhost/client.json",
    "https://agent.example:8443/client.json",
    "https://agent.example/a/../client.json",
    "https://git.example.test/acme/infra/raw/main/client.json",
  ])("never fetches %s", async (clientId) => {
    const source = documents({ ...good, client_id: clientId });
    const page = await show(makeSite({ documents: source.fetch }), clientId);
    expect(page.status).toBe(400);
    expect(source.fetched).toEqual([]);
  });
});

describe("the consent page", () => {
  let site: Site;
  let clientId: string;
  beforeEach(async () => {
    site = makeSite();
    clientId = (await json(await register(site))).client_id;
  });

  it("sends a signed-out browser to sign in and back", async () => {
    const url = await authorizeUrl(clientId);
    const response = await site.fetch(url, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!, ORIGIN);
    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.get("returnTo")).toBe(`${url.pathname}${url.search}`);
  });

  it("shows who is asking, for what, and where the answer goes", async () => {
    const response = await site.fetch(await authorizeUrl(clientId), {
      headers: { cookie: "session=alice" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const policy = response.headers.get("content-security-policy")!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // The form may post here and be redirected to the client, and nowhere else.
    expect(policy).toContain("form-action 'self' http://127.0.0.1:43110;");
    expect(policy).not.toContain("unsafe-inline");
    const html = await response.text();
    expect(html).toContain("Test Agent wants access to git.example.test");
    expect(html).toContain("127.0.0.1:43110");
    expect(html).toContain("alice");
    expect(html).toContain("program on this computer");
    expect(html).not.toContain("<script");
    expect(consentRequestOf(html)).toMatch(/^v1\./);
  });

  it("escapes what a client calls itself", async () => {
    const hostile = (
      await json(await register(site, { client_name: `<img src=x onerror=alert(1)>"'&` }))
    ).client_id;
    const html = await (
      await site.fetch(await authorizeUrl(hostile), { headers: { cookie: "session=alice" } })
    ).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
  });

  it("shows a problem, and redirects nowhere, until the redirect URI is known", async () => {
    for (const overrides of [
      { redirect_uri: "https://evil.example/cb" },
      { redirect_uri: "http://127.0.0.1:43110/other" },
      { client_id: null },
    ]) {
      const response = await site.fetch(await authorizeUrl(clientId, overrides), {
        headers: { cookie: "session=alice" },
        redirect: "manual",
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it.each([
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge: null }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge_method: null }, "invalid_request"],
    [{ resource: "https://other.example/mcp" }, "invalid_target"],
  ])("tells the client about %j", async (overrides, error) => {
    const response = await site.fetch(await authorizeUrl(clientId, overrides), {
      headers: { cookie: "session=alice" },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe(error);
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("shows the problem and a link, not a redirect, when the address is not this machine's", async () => {
    // Anyone can register a client: an automatic redirect to its address would be an open one.
    const elsewhere = "https://client.example/callback";
    const remote: string = (await json(await register(site, { redirect_uris: [elsewhere] })))
      .client_id;
    const response = await site.fetch(
      await authorizeUrl(remote, { redirect_uri: elsewhere, code_challenge: null }),
      { headers: { cookie: "session=alice" }, redirect: "manual" },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("PKCE is required");
    const link = new URL(/href="([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, "&"));
    expect(`${link.origin}${link.pathname}`).toBe(elsewhere);
    expect(link.searchParams.get("error")).toBe("invalid_request");
    expect(link.searchParams.get("state")).toBe("state-123");
    expect(link.searchParams.get("iss")).toBe(ORIGIN);
    // Once the person has pressed a button, the browser does go there.
    const back = await browse(
      site,
      await authorizeUrl(remote, { redirect_uri: elsewhere }),
      "alice",
    );
    expect(`${back.origin}${back.pathname}`).toBe(elsewhere);
    expect(back.searchParams.get("code")).toMatch(/^iwa_/);
  });

  it("looks at nothing of the client until the person has signed in", async () => {
    const fetched: string[] = [];
    const quiet = makeSite({
      documents: async (url) => {
        fetched.push(url);
        return new Response("{}", { status: 200 });
      },
    });
    for (const id of ["https://agent.example/client.json", "nobody", "iwc_forged"]) {
      const response = await quiet.fetch(await authorizeUrl(id), { redirect: "manual" });
      // The same answer whoever the client is: sign in first.
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location")!, ORIGIN).pathname).toBe("/auth/sign-in");
    }
    expect(fetched).toEqual([]);
  });

  it("answers the client with a code, its state and the issuer when allowed", async () => {
    const back = await browse(site, await authorizeUrl(clientId), "alice");
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("code")).toMatch(/^iwa_/);
    expect(back.searchParams.get("state")).toBe("state-123");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
    // Nothing is granted until the code is exchanged.
    expect(site.store.rows.size).toBe(0);
  });

  it("answers access_denied when denied", async () => {
    const back = await browse(site, await authorizeUrl(clientId), "alice", "deny");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
  });

  const decide = async (headers: Record<string, string>, sealed: string, decision = "allow") =>
    site.fetch(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ request: sealed, decision }),
    });
  const shown = async (userId = "alice") =>
    consentRequestOf(
      await (
        await site.fetch(await authorizeUrl(clientId), {
          headers: { cookie: `session=${userId}` },
        })
      ).text(),
    );

  it("takes the decision only from its own page", async () => {
    const sealed = await shown();
    // Another site's form: the cookie rides along, the origin gives it away.
    for (const headers of [
      { cookie: "session=alice", origin: "https://evil.example" },
      { cookie: "session=alice", "sec-fetch-site": "cross-site" },
      { cookie: "session=alice", "sec-fetch-site": "same-site" },
      // No word on where it came from is not good enough for a cookie.
      { cookie: "session=alice" },
      // And nobody signed in at all.
      { origin: ORIGIN },
    ]) {
      const response = await decide(headers, sealed);
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    }
    expect((await decide({ cookie: "session=alice", origin: ORIGIN }, sealed)).status).toBe(303);
  });

  it("takes the decision only from the person the page was shown to", async () => {
    const sealed = await shown("alice");
    const response = await decide({ cookie: "session=mallory", origin: ORIGIN }, sealed);
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses a form that is forged, of another kind, or stale", async () => {
    const own = { cookie: "session=alice", origin: ORIGIN };
    const consent = {
      u: "alice",
      c: clientId,
      n: "x",
      r: "https://evil.example/cb",
      k: "k",
      s: [],
      t: null,
    };
    for (const sealed of [
      "garbage",
      await seal(consent, PASSWORD),
      await sealAs("code", consent, PASSWORD),
      await sealAs("consent", consent, "another-password-of-at-least-thirty-two-chars"),
      await sealAs("consent", consent, PASSWORD, Date.now() - 1),
    ]) {
      const response = await decide(own, sealed);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
    expect((await decide(own, await shown(), "maybe")).status).toBe(400);
  });

  it("stops taking a page's form after ten minutes", async () => {
    let now = Date.now();
    site = makeSite({ now: () => now });
    clientId = (await json(await register(site))).client_id;
    const sealed = await shown();
    now += OAUTH_LIFETIMES.consentSeconds * 1000 + 1;
    expect((await decide({ cookie: "session=alice", origin: ORIGIN }, sealed)).status).toBe(400);
  });
});

describe("the token endpoint", () => {
  it("exchanges a code and its verifier for a token that works", async () => {
    const site = makeSite();
    const { answer, tokens } = await signIn(site);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: OAUTH_LIFETIMES.accessTokenSeconds,
      scope: "repo:read repo:write",
    });
    expect(tokens.access_token).toMatch(/^iwg_/);
    expect(tokens.refresh_token).toMatch(/^iwr_/);
    const [row] = [...site.store.rows.values()];
    expect(row).toMatchObject({ userId: "alice", name: "Test Agent (MCP)", revokedAt: null });
    expect(row!.id).toMatch(/^mcp_/);
    // Only the hash is kept.
    expect(JSON.stringify(row)).not.toContain(tokens.access_token);
    expect((await callMcp(site, tokens.access_token)).status).toBe(200);
  });

  it("grants only the scopes asked for", async () => {
    const site = makeSite();
    const clientId: string = (await json(await register(site))).client_id;
    const back = await browse(
      site,
      await authorizeUrl(clientId, { scope: "repo:read openid" }),
      "alice",
    );
    const tokens = await json(
      await token(site, {
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        code_verifier: VERIFIER,
        client_id: clientId,
      }),
    );
    expect(tokens.scope).toBe("repo:read");
    expect([...site.store.rows.values()][0]!.scopes).toEqual(["repo:read"]);
    expect(parseScopes("offline_access")).toEqual(["repo:read", "repo:write"]);
    expect(parseScopes("repo:write")).toEqual(["repo:read", "repo:write"]);
    expect(parseScopes(null)).toEqual(["repo:read", "repo:write"]);
  });

  it("refuses the wrong verifier, client, redirect or resource, and grants nothing", async () => {
    const site = makeSite();
    const clientId: string = (await json(await register(site))).client_id;
    const other: string = (await json(await register(site, { client_name: "Other" }))).client_id;
    const attempt = async (overrides: Record<string, string>) => {
      const back = await browse(site, await authorizeUrl(clientId), "alice");
      return token(site, {
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        code_verifier: VERIFIER,
        client_id: clientId,
        ...overrides,
      });
    };
    for (const [overrides, error] of [
      [{ code_verifier: "w".repeat(60) }, "invalid_grant"],
      [{ code_verifier: "short" }, "invalid_grant"],
      [{ client_id: other }, "invalid_grant"],
      [{ redirect_uri: "http://127.0.0.1:43110/other" }, "invalid_grant"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
      [{ code: "iwa_nonsense" }, "invalid_grant"],
      [{ grant_type: "client_credentials" }, "unsupported_grant_type"],
      [{ grant_type: "password" }, "unsupported_grant_type"],
    ] as const) {
      const response = await attempt(overrides);
      expect([overrides, response.status]).toEqual([overrides, 400]);
      expect((await json(response)).error).toBe(error);
    }
    expect(site.store.rows.size).toBe(0);
    expect(
      (await token(site, { grant_type: "authorization_code", code: "x", code_verifier: VERIFIER }))
        .status,
    ).toBe(400);
  });

  it("takes a code once, and ends the grant when it is presented again", async () => {
    const site = makeSite();
    const { clientId, code, tokens } = await signIn(site);
    const again = await token(site, {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: clientId,
    });
    expect(again.status).toBe(400);
    expect((await json(again)).error).toBe("invalid_grant");
    expect(site.store.rows.size).toBe(1);
    // Whoever exchanged it first may not have been the client.
    expect((await callMcp(site, tokens.access_token)).status).toBe(401);
  });

  it("stops taking a code after a minute", async () => {
    let now = Date.now();
    const site = makeSite({ now: () => now });
    const clientId: string = (await json(await register(site))).client_id;
    const back = await browse(site, await authorizeUrl(clientId), "alice");
    now += OAUTH_LIFETIMES.codeSeconds * 1000 + 1;
    const response = await token(site, {
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: VERIFIER,
      client_id: clientId,
    });
    expect(response.status).toBe(400);
    expect(site.store.rows.size).toBe(0);
  });

  it("does not take one kind of sealed value for another", async () => {
    const site = makeSite();
    const { clientId, code, tokens } = await signIn(site);
    const asCode = await token(site, {
      grant_type: "authorization_code",
      code: `iwa_${tokens.refresh_token.slice(4)}`,
      code_verifier: VERIFIER,
      client_id: clientId,
    });
    expect(asCode.status).toBe(400);
    const asRefresh = await token(site, {
      grant_type: "refresh_token",
      refresh_token: `iwr_${code.slice(4)}`,
      client_id: clientId,
    });
    expect(asRefresh.status).toBe(400);
    expect(await unsealAs("refresh", code.slice(4), PASSWORD)).toBeNull();
    expect(await unsealAs("code", code.slice(4), PASSWORD)).not.toBeNull();
  });
});

describe("refreshing", () => {
  const refresh = (site: Site, clientId: string, refreshToken: string) =>
    token(site, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });

  it("gives the next access token and refresh token, and retires the old ones", async () => {
    let now = Date.now();
    const site = makeSite({ now: () => now });
    const { clientId, tokens } = await signIn(site);
    now += 30 * 60 * 1000;
    const next = await json(await refresh(site, clientId, tokens.refresh_token));
    expect(next.access_token).toMatch(/^iwg_/);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.scope).toBe("repo:read repo:write");
    // One row for the grant, whatever was refreshed.
    expect(site.store.rows.size).toBe(1);
    expect((await callMcp(site, next.access_token)).status).toBe(200);
    expect((await callMcp(site, tokens.access_token)).status).toBe(401);
  });

  it("lets an expired access token be refreshed, until the grant lapses", async () => {
    let now = Date.now();
    const site = makeSite({ now: () => now });
    const { clientId, tokens } = await signIn(site);
    now += OAUTH_LIFETIMES.accessTokenSeconds * 1000 + 1;
    expect((await callMcp(site, tokens.access_token)).status).toBe(401);
    const next = await json(await refresh(site, clientId, tokens.refresh_token));
    expect((await callMcp(site, next.access_token)).status).toBe(200);

    const [row] = [...site.store.rows.values()];
    now = grantLapsesAt(row!.expiresAt!).getTime();
    expect((await refresh(site, clientId, next.refresh_token)).status).toBe(400);
  });

  it("refuses a refresh token used twice, and ends the grant unless it was just a race", async () => {
    let now = Date.now();
    const site = makeSite({ now: () => now });
    const { clientId, tokens } = await signIn(site);
    const next = await json(await refresh(site, clientId, tokens.refresh_token));

    // At once: two processes of one client shared the token. Refused, and the grant stands.
    now += 5_000;
    const raced = await refresh(site, clientId, tokens.refresh_token);
    expect(raced.status).toBe(400);
    expect((await json(raced)).error).toBe("invalid_grant");
    expect((await callMcp(site, next.access_token)).status).toBe(200);

    // Later: somebody else has the old token. The grant ends for both.
    now += OAUTH_LIFETIMES.refreshRaceSeconds * 1000;
    expect((await refresh(site, clientId, tokens.refresh_token)).status).toBe(400);
    expect((await callMcp(site, next.access_token)).status).toBe(401);
    expect((await refresh(site, clientId, next.refresh_token)).status).toBe(400);
  });

  it("refuses another client's refresh token, a forged one, and one of a revoked grant", async () => {
    const site = makeSite();
    const { clientId, tokens } = await signIn(site);
    const other: string = (await json(await register(site, { client_name: "Other" }))).client_id;
    expect((await refresh(site, other, tokens.refresh_token)).status).toBe(400);
    expect((await refresh(site, clientId, "iwr_forged")).status).toBe(400);
    const forged = `iwr_${await sealAs("refresh", { id: "mcp_x", h: "h", c: "c" }, "another-password-of-at-least-thirty-two-chars")}`;
    expect((await refresh(site, clientId, forged)).status).toBe(400);
    // The person revoked it from their settings.
    for (const row of site.store.rows.values()) await site.store.revoke(row.id);
    expect((await refresh(site, clientId, tokens.refresh_token)).status).toBe(400);
    expect((await callMcp(site, tokens.access_token)).status).toBe(401);
  });
});

describe("revoking", () => {
  const revoke = (site: Site, value: string) =>
    site.fetch(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: value }),
    });

  it("ends the grant, given its access token or its refresh token", async () => {
    for (const which of ["access_token", "refresh_token"] as const) {
      const site = makeSite();
      const { clientId, tokens } = await signIn(site);
      expect((await revoke(site, tokens[which])).status).toBe(200);
      expect((await callMcp(site, tokens.access_token)).status).toBe(401);
      const refreshed = await token(site, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      });
      expect(refreshed.status).toBe(400);
    }
  });

  it("answers 200 for a token it does not know, and leaves a personal token alone", async () => {
    const site = makeSite();
    const personal = await mintAccessToken();
    await site.store.insert({
      id: "a-token-made-by-hand",
      userId: "alice",
      name: "laptop",
      prefix: personal.prefix,
      hash: personal.hash,
      scopes: ["repo:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await revoke(site, "iwg_unknown")).status).toBe(200);
    expect((await revoke(site, "iwr_unknown")).status).toBe(200);
    expect((await revoke(site, personal.secret)).status).toBe(200);
    expect(site.store.rows.get("a-token-made-by-hand")!.revokedAt).toBeNull();
    expect((await revoke(site, "")).status).toBe(400);
  });
});

describe("the resource parameter", () => {
  it("names this server and nothing else", () => {
    for (const resource of [
      `${ORIGIN}/mcp`,
      `${ORIGIN}/mcp/`,
      ORIGIN,
      `${ORIGIN}/`,
      "HTTPS://GIT.EXAMPLE.TEST/mcp",
    ]) {
      expect([resource, isOurResource(resource, ORIGIN)]).toEqual([resource, true]);
    }
    for (const resource of [
      `${ORIGIN}/api`,
      `${ORIGIN}/mcp?x=1`,
      `${ORIGIN}/mcp#x`,
      "https://git.example.test.evil.example/mcp",
      "http://git.example.test/mcp",
      "mcp",
    ]) {
      expect([resource, isOurResource(resource, ORIGIN)]).toEqual([resource, false]);
    }
  });
});
