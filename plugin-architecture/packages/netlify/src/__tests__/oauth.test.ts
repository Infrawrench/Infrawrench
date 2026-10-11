import { describe, expect, it, vi } from "vitest";
import { buildOAuthAuthorizeUrl, exchangeOAuthCode } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { completeNetlifyOAuth } from "../oauth.js";

describe("Netlify OAuth declaration", () => {
  const decl = plugin.manifest.oauth!;

  it("fills the existing token field, server only, full access, no refresh", () => {
    expect(decl.tokenField).toBe("accessToken");
    expect(plugin.manifest.credentialFields.map((f) => f.key)).toContain("accessToken");
    expect(decl.clients.server).toBeDefined();
    expect(decl.clients.desktop).toBeUndefined();
    expect(decl.access).toBe("full");
    expect(decl.refresh).toBe("none");
    expect(plugin.completeOAuthConnection).toBe(completeNetlifyOAuth);
  });

  it("builds a code-flow authorize URL on app.netlify.com without scopes", () => {
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "https://app.example.com/api/provider-oauth/netlify/callback",
        state: "st",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://app.netlify.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("exchanges the code with the client secret in the form body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "nf-oauth", token_type: "Bearer", created_at: 1 }),
          { status: 200 },
        ),
    );
    const tokens = await exchangeOAuthCode(decl, {
      code: "c",
      redirectUri: "https://app.example.com/cb",
      client: { clientId: "cid", clientSecret: "sec", auth: "client_secret_post" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(tokens.accessToken).toBe("nf-oauth");
    expect(tokens.expiresAt).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.netlify.com/oauth/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBe("sec");
  });
});

describe("completeNetlifyOAuth", () => {
  const tokens = { accessToken: "nf-oauth", raw: {} };

  it("names the account after the user", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ full_name: "Ada L", email: "ada@example.com" }), {
          status: 200,
        }),
    );
    const res = await completeNetlifyOAuth(tokens, {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "Ada L" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.netlify.com/api/v1/user");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer nf-oauth");
  });

  it("returns nothing when the lookup fails", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    expect(
      await completeNetlifyOAuth(tokens, {
        client: "server",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).toEqual({});
  });
});
