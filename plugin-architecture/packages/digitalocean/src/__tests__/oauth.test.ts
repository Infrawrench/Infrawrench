import { describe, expect, it, vi } from "vitest";
import {
  buildOAuthAuthorizeUrl,
  desktopOAuthRedirectUri,
  exchangeOAuthCode,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { DIGITALOCEAN_OAUTH_SCOPES, completeDigitalOceanOAuth } from "../oauth.js";

/** Token grant shaped like the example in DigitalOcean's OAuth reference. */
const GRANT = {
  access_token: "doo_v1_access",
  token_type: "bearer",
  expires_in: 2592000,
  refresh_token: "dor_v1_refresh",
  scope: "droplet:read",
  info: {
    name: "Sammy the Shark",
    email: "sammy@example.com",
    uuid: "user-uuid",
    team_uuid: "team-uuid",
    team_name: "My Team",
  },
};

function tokens(raw: Record<string, unknown>): OAuthTokenSet {
  return { accessToken: "doo_v1_access", raw };
}

describe("DigitalOcean OAuth declaration", () => {
  const decl = plugin.manifest.oauth!;

  it("puts the token where the client reads a pasted one", () => {
    expect(decl.tokenField).toBe("apiToken");
    expect(plugin.manifest.credentialFields.some((f) => f.key === decl.tokenField)).toBe(true);
  });

  it("offers both a confidential server client and a public desktop client", () => {
    expect(decl.clients.server).toEqual({ auth: "client_secret_post", pkce: true });
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
    expect(decl.refresh).toBe("rotating");
  });

  it("asks for granular scopes, never the catch-all aliases", () => {
    expect(DIGITALOCEAN_OAUTH_SCOPES).toContain("droplet:read");
    expect(DIGITALOCEAN_OAUTH_SCOPES).toContain("billing:read");
    expect(DIGITALOCEAN_OAUTH_SCOPES).toContain("database:view_credentials");
    expect(DIGITALOCEAN_OAUTH_SCOPES).not.toContain("api:write");
    expect(DIGITALOCEAN_OAUTH_SCOPES).not.toContain("api:read");
    expect(new Set(DIGITALOCEAN_OAUTH_SCOPES).size).toBe(DIGITALOCEAN_OAUTH_SCOPES.length);
    for (const s of DIGITALOCEAN_OAUTH_SCOPES) expect(s).toMatch(/^[a-z_]+:[a-z_]+$/);
  });

  it("builds a space-separated authorize URL", () => {
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example/cb",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://cloud.digitalocean.com/v1/oauth/authorize");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(DIGITALOCEAN_OAUTH_SCOPES);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges a code with the standard helper", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(GRANT), { status: 200 }));
    const set = await exchangeOAuthCode(decl, {
      code: "c",
      redirectUri: "https://app.example/cb",
      client: { clientId: "cid", clientSecret: "sec", auth: "client_secret_post" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(set.accessToken).toBe("doo_v1_access");
    expect(set.refreshToken).toBe("dor_v1_refresh");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.digitalocean.com/v1/oauth/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("client_secret")).toBe("sec");
    expect(body.get("grant_type")).toBe("authorization_code");
  });
});

describe("completeDigitalOceanOAuth", () => {
  it("names the account after the authorized team from the token response", async () => {
    const fetchMock = vi.fn();
    const res = await completeDigitalOceanOAuth(tokens(GRANT), {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "My Team" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to /v2/account when the response has no info", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ account: { email: "sammy@example.com", team: { name: "Ops" } } }),
          { status: 200 },
        ),
    );
    const res = await completeDigitalOceanOAuth(tokens({ access_token: "x" }), {
      client: "desktop",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "Ops" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.digitalocean.com/v2/account");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer doo_v1_access");
  });

  it("returns nothing rather than failing when the lookup fails", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
    const res = await completeDigitalOceanOAuth(tokens({}), {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({});
  });
});
