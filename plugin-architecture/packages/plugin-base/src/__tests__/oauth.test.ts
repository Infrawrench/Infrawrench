import { describe, expect, it, vi } from "vitest";

import {
  OAUTH_CREDENTIAL_KEY,
  OAuthTokenError,
  applyOAuthTokens,
  buildOAuthAuthorizeUrl,
  createPkcePair,
  desktopOAuthRedirectUri,
  exchangeOAuthCode,
  oauthEnvPrefix,
  oauthNeedsRefresh,
  parseOAuthTokenResponse,
  readOAuthGrantState,
  refreshOAuthToken,
  stripOAuthGrantState,
  type OAuthDeclaration,
} from "../oauth.js";

const declaration: OAuthDeclaration = {
  authorizeUrl: "https://example.test/oauth/authorize?existing=1",
  tokenUrl: "https://example.test/oauth/token",
  scopes: ["read", "write"],
  authorizeParams: { prompt: "consent" },
  tokenField: "apiToken",
  clients: { server: { pkce: true }, desktop: { loopbackHost: "localhost" } },
  access: "read-only",
  refresh: "rotating",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("provider oauth helpers", () => {
  it("builds an authorize URL with scopes, PKCE and extra params", () => {
    const url = new URL(
      buildOAuthAuthorizeUrl(declaration, {
        clientId: "cid",
        redirectUri: "https://app.test/cb",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.searchParams.get("existing")).toBe("1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("derives a verifiable S256 challenge", async () => {
    const { verifier, challenge } = await createPkcePair();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("exchanges a code with client_secret_post and parses the token set", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_secret")).toBe("sec");
      expect(body.get("code_verifier")).toBe("ver");
      return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    });
    const tokens = await exchangeOAuthCode(declaration, {
      code: "c",
      redirectUri: "https://app.test/cb",
      codeVerifier: "ver",
      client: { clientId: "cid", clientSecret: "sec", auth: "client_secret_post" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("sends basic auth and flags invalid_grant on refresh", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toMatch(/^Basic /);
      return jsonResponse({ error: "invalid_grant" }, 400);
    });
    const err = await refreshOAuthToken(
      declaration,
      "rt",
      { clientId: "cid", clientSecret: "sec", auth: "client_secret_basic" },
      fetchMock as unknown as typeof fetch,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthTokenError);
    expect((err as OAuthTokenError).invalidGrant).toBe(true);
  });

  it("stores, reads and strips grant state, keeping the refresh token across rotations", () => {
    const credentials: Record<string, string> = { region: "eu" };
    applyOAuthTokens(
      declaration,
      credentials,
      parseOAuthTokenResponse({ access_token: "a1", refresh_token: "r1", expires_in: 60 }),
      "server",
    );
    applyOAuthTokens(
      declaration,
      credentials,
      parseOAuthTokenResponse({ access_token: "a2" }),
      "server",
    );
    expect(credentials["apiToken"]).toBe("a2");
    const state = readOAuthGrantState(credentials);
    expect(state?.refreshToken).toBe("r1");
    expect(state?.client).toBe("server");
    expect(stripOAuthGrantState(credentials)).toEqual({ region: "eu", apiToken: "a2" });
    expect(readOAuthGrantState({ apiToken: "pasted" })).toBeNull();
    expect(credentials[OAUTH_CREDENTIAL_KEY]).toBeDefined();
  });

  it("refreshes inside the margin only when a refresh token exists", () => {
    const now = 1_000_000;
    expect(
      oauthNeedsRefresh(
        { v: 1, client: "server", connectedAt: 0, refreshToken: "r", expiresAt: now + 60_000 },
        now,
      ),
    ).toBe(true);
    expect(
      oauthNeedsRefresh(
        { v: 1, client: "server", connectedAt: 0, refreshToken: "r", expiresAt: now + 3_600_000 },
        now,
      ),
    ).toBe(false);
    expect(oauthNeedsRefresh({ v: 1, client: "server", connectedAt: 0, expiresAt: now }, now)).toBe(
      false,
    );
  });

  it("names env vars and the desktop redirect", () => {
    expect(oauthEnvPrefix("hugging-face")).toBe("PROVIDER_OAUTH_HUGGING_FACE");
    expect(desktopOAuthRedirectUri(declaration)).toBe("http://localhost:43118/oauth/callback");
  });
});
