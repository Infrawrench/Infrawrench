import { describe, expect, it, vi } from "vitest";
import { OAuthTokenError, type OAuthTokenSet } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import {
  buildVercelAuthorizeUrl,
  completeVercelOAuth,
  exchangeVercelCode,
  VERCEL_INTEGRATION_SLUG,
} from "../oauth.js";

function routes(map: Record<string, { status: number; body: unknown }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, r] of Object.entries(map)) {
      if (url.includes(needle)) return new Response(JSON.stringify(r.body), { status: r.status });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
}

describe("Vercel OAuth declaration", () => {
  const decl = plugin.manifest.oauth!;

  it("fills the existing access token field and is server only, never refreshed", () => {
    expect(decl.tokenField).toBe("accessToken");
    expect(plugin.manifest.credentialFields.map((f) => f.key)).toContain("accessToken");
    expect(decl.clients.server).toBeDefined();
    expect(decl.clients.desktop).toBeUndefined();
    expect(decl.refresh).toBe("none");
  });

  it("wires the hooks", () => {
    expect(plugin.buildOAuthAuthorizeUrl).toBe(buildVercelAuthorizeUrl);
    expect(plugin.exchangeOAuthCode).toBe(exchangeVercelCode);
    expect(plugin.completeOAuthConnection).toBe(completeVercelOAuth);
  });

  it("sends the user to the integration install URL with only the state", () => {
    const url = new URL(
      buildVercelAuthorizeUrl({
        clientId: "oac_1",
        redirectUri: "https://app.example.com/api/provider-oauth/vercel/callback",
        state: "sealed-state",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      `https://vercel.com/integrations/${VERCEL_INTEGRATION_SLUG}/new`,
    );
    expect([...url.searchParams.keys()]).toEqual(["state"]);
    expect(url.searchParams.get("state")).toBe("sealed-state");
  });
});

describe("exchangeVercelCode", () => {
  it("posts the four documented form fields and keeps team_id", async () => {
    const fetchMock = routes({
      "/v2/oauth/access_token": {
        status: 200,
        body: {
          token_type: "Bearer",
          access_token: "vercel-token",
          installation_id: "icfg_1",
          user_id: "u1",
          team_id: "team_1",
        },
      },
    });
    const tokens = await exchangeVercelCode({
      code: "c0de",
      redirectUri: "https://app.example.com/cb",
      client: { clientId: "oac_1", clientSecret: "s3cret", auth: "client_secret_post" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(tokens.accessToken).toBe("vercel-token");
    expect(tokens.expiresAt).toBeUndefined();
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.raw["team_id"]).toBe("team_1");
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: "oac_1",
      client_secret: "s3cret",
      code: "c0de",
      redirect_uri: "https://app.example.com/cb",
    });
  });

  it("raises an OAuthTokenError with Vercel's message", async () => {
    const fetchMock = routes({
      "/v2/oauth/access_token": {
        status: 400,
        body: { error: { code: "bad_request", message: "Code is invalid" } },
      },
    });
    const err = await exchangeVercelCode({
      code: "used",
      redirectUri: "https://app.example.com/cb",
      client: { clientId: "oac_1", clientSecret: "s", auth: "client_secret_post" },
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthTokenError);
    expect((err as Error).message).toBe("Code is invalid");
  });
});

describe("completeVercelOAuth", () => {
  const base: OAuthTokenSet = { accessToken: "vercel-token", raw: {} };

  it("pre-fills the team id and names the account after the team", async () => {
    const fetchMock = routes({
      "/v2/teams/team_1": { status: 200, body: { id: "team_1", name: "Acme", slug: "acme" } },
    });
    const res = await completeVercelOAuth(
      { ...base, raw: { team_id: "team_1" } },
      { client: "server", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(res).toEqual({ credentials: { teamId: "team_1" }, accountName: "Acme" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("teamId=team_1");
  });

  it("keeps the team id even when the team lookup fails", async () => {
    const fetchMock = routes({ "/v2/teams/": { status: 403, body: {} } });
    const res = await completeVercelOAuth(
      { ...base, raw: { team_id: "team_1" } },
      { client: "server", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(res).toEqual({ credentials: { teamId: "team_1" } });
  });

  it("names a personal install after the user", async () => {
    const fetchMock = routes({
      "/v2/user": { status: 200, body: { user: { username: "ada", name: "Ada L" } } },
    });
    const res = await completeVercelOAuth(
      { ...base, raw: { team_id: null } },
      { client: "server", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(res).toEqual({ accountName: "Ada L" });
  });
});
