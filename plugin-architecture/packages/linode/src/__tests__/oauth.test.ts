import { describe, expect, it, vi } from "vitest";
import {
  buildOAuthAuthorizeUrl,
  refreshOAuthToken,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { LINODE_OAUTH_SCOPES, completeLinodeOAuth } from "../oauth.js";
import { LINODE_PREFLIGHT } from "../preflight.js";

const TOKENS: OAuthTokenSet = { accessToken: "ln-oauth-access", raw: {} };

function routes(map: Record<string, { status: number; body: unknown }>) {
  return vi.fn(async (input: string, _init?: RequestInit) => {
    for (const [suffix, r] of Object.entries(map)) {
      if (input.endsWith(suffix)) return new Response(JSON.stringify(r.body), { status: r.status });
    }
    throw new Error(`unstubbed fetch: ${input}`);
  });
}

describe("Linode OAuth declaration", () => {
  const decl = plugin.manifest.oauth!;

  it("is server-only: Linode's public clients get no refresh token", () => {
    expect(decl.clients.server).toBeDefined();
    expect(decl.clients.desktop).toBeUndefined();
    expect(decl.tokenField).toBe("apiToken");
  });

  it("requests exactly the scopes the preflight probes for", () => {
    const fromPreflight = LINODE_PREFLIGHT.capabilities.flatMap((c) =>
      c.requiredPermissions.map((p) => p.id),
    );
    expect(new Set(LINODE_OAUTH_SCOPES)).toEqual(new Set(fromPreflight));
    expect(LINODE_OAUTH_SCOPES).toContain("account:read_only");
    expect(LINODE_OAUTH_SCOPES).toContain("linodes:read_write");
    for (const s of LINODE_OAUTH_SCOPES) expect(s).toMatch(/^[a-z_]+:read_(only|write)$/);
  });

  it("sends the comma-separated scope list as both scope and scopes", () => {
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example/api/provider-oauth/linode/callback",
        state: "st",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://login.linode.com/oauth/authorize");
    const joined = LINODE_OAUTH_SCOPES.join(",");
    expect(url.searchParams.get("scope")).toBe(joined);
    expect(url.searchParams.get("scopes")).toBe(joined);
  });

  it("refreshes with the client credentials in the form body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "new",
            refresh_token: "r2",
            expires_in: 7200,
            token_type: "bearer",
            scopes: "linodes:read_write",
          }),
          { status: 200 },
        ),
    );
    const set = await refreshOAuthToken(
      decl,
      "r1",
      { clientId: "cid", clientSecret: "sec", auth: "client_secret_post" },
      fetchMock as unknown as typeof fetch,
    );
    expect(set.refreshToken).toBe("r2");
    expect(set.expiresAt).toBeGreaterThan(Date.now());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://login.linode.com/oauth/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("sec");
  });
});

describe("completeLinodeOAuth", () => {
  it("names the account after the Linode account's company", async () => {
    const fetchMock = routes({ "/account": { status: 200, body: { company: "Acme Ltd" } } });
    const res = await completeLinodeOAuth(TOKENS, {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "Acme Ltd" });
    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer ln-oauth-access",
    );
  });

  it("falls back to the username when there is no company", async () => {
    const fetchMock = routes({
      "/account": { status: 200, body: { company: "" } },
      "/profile": { status: 200, body: { username: "jdoe", email: "j@example.com" } },
    });
    const res = await completeLinodeOAuth(TOKENS, {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "jdoe" });
  });

  it("returns nothing when both lookups fail", async () => {
    const fetchMock = routes({
      "/account": { status: 403, body: {} },
      "/profile": { status: 401, body: {} },
    });
    const res = await completeLinodeOAuth(TOKENS, {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({});
  });
});
