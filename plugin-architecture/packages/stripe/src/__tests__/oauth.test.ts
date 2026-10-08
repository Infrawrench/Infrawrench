import { describe, expect, it, vi } from "vitest";
import { OAuthTokenError, refreshOAuthToken, type OAuthTokenSet } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { dashboardUrl, keyMode } from "../api.js";
import {
  buildStripeAuthorizeUrl,
  completeStripeOAuth,
  exchangeStripeCode,
  stripeOAuth,
} from "../oauth.js";

const TOKEN_BODY = {
  access_token: "stripe-app-access",
  livemode: true,
  refresh_token: "stripe-app-refresh",
  scope: "stripe_apps",
  stripe_publishable_key: "pk_live_x",
  stripe_user_id: "acct_123",
  token_type: "bearer",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("Stripe OAuth declaration", () => {
  const decl = plugin.manifest.oauth!;

  it("fills the API key field, server only, rotating refresh", () => {
    expect(decl).toBe(stripeOAuth);
    expect(decl.tokenField).toBe("apiKey");
    expect(decl.clients.server?.auth).toBe("client_secret_post");
    expect(decl.clients.desktop).toBeUndefined();
    expect(decl.refresh).toBe("rotating");
    expect(plugin.buildOAuthAuthorizeUrl).toBe(buildStripeAuthorizeUrl);
    expect(plugin.exchangeOAuthCode).toBe(exchangeStripeCode);
    expect(plugin.completeOAuthConnection).toBe(completeStripeOAuth);
  });

  it("builds the marketplace install link with only the documented parameters", () => {
    const url = new URL(
      buildStripeAuthorizeUrl({
        clientId: "ca_123",
        redirectUri: "https://app.example.com/api/provider-oauth/stripe/callback",
        state: "st",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://marketplace.stripe.com/oauth/v2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "ca_123",
      redirect_uri: "https://app.example.com/api/provider-oauth/stripe/callback",
      state: "st",
    });
  });
});

describe("exchangeStripeCode", () => {
  it("authenticates with the secret key as the Basic username and assumes a one-hour token", async () => {
    const fetchMock = vi.fn(async () => json(TOKEN_BODY));
    const before = Date.now();
    const tokens = await exchangeStripeCode({
      code: "ac_123",
      redirectUri: "https://app.example.com/cb",
      client: { clientId: "ca_123", clientSecret: "sk_live_platform", auth: "client_secret_post" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(tokens.accessToken).toBe("stripe-app-access");
    expect(tokens.refreshToken).toBe("stripe-app-refresh");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(tokens.raw["stripe_user_id"]).toBe("acct_123");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/oauth/token");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${btoa("sk_live_platform:")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code",
      code: "ac_123",
    });
  });

  it("reports Stripe errors, flagging invalid_grant", async () => {
    const fetchMock = vi.fn(async () =>
      json({ error: "invalid_grant", error_description: "Authorization code expired" }, 400),
    );
    const err = await exchangeStripeCode({
      code: "old",
      redirectUri: "https://app.example.com/cb",
      client: { clientId: "ca_123", clientSecret: "sk_live_platform", auth: "client_secret_post" },
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthTokenError);
    expect((err as OAuthTokenError).invalidGrant).toBe(true);
    expect((err as Error).message).toBe("Authorization code expired");

    const apiError = vi.fn(async () =>
      json({ error: { message: "Invalid API Key provided", type: "invalid_request_error" } }, 401),
    );
    const err2 = await exchangeStripeCode({
      code: "c",
      redirectUri: "https://app.example.com/cb",
      client: { clientId: "ca_123", clientSecret: "sk_bad", auth: "client_secret_post" },
      fetch: apiError as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect((err2 as Error).message).toBe("Invalid API Key provided");
  });

  it("refreshes through the host helper with the secret key as client_secret", async () => {
    const fetchMock = vi.fn(async () => json(TOKEN_BODY));
    const before = Date.now();
    const tokens = await refreshOAuthToken(
      stripeOAuth,
      "stripe-app-refresh",
      { clientId: "ca_123", clientSecret: "sk_live_platform", auth: "client_secret_post" },
      fetchMock as unknown as typeof fetch,
    );
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = new URLSearchParams(String(init.body));
    expect(body.get("client_secret")).toBe("sk_live_platform");
    expect(body.get("grant_type")).toBe("refresh_token");
  });
});

describe("completeStripeOAuth", () => {
  const tokens: OAuthTokenSet = { accessToken: "stripe-app-access", raw: TOKEN_BODY };

  it("names the account after the Stripe account's display name", async () => {
    const fetchMock = vi.fn(async () =>
      json({ id: "acct_123", settings: { dashboard: { display_name: "Acme" } } }),
    );
    const res = await completeStripeOAuth(tokens, {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "Acme" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer stripe-app-access",
    );
  });

  it("falls back to the account id and marks test mode", async () => {
    const fetchMock = vi.fn(async () => json({ error: { message: "nope" } }, 403));
    const res = await completeStripeOAuth(
      { ...tokens, raw: { ...TOKEN_BODY, livemode: false } },
      { client: "server", fetch: fetchMock as unknown as typeof fetch },
    );
    expect(res).toEqual({ accountName: "acct_123 (test)" });
  });
});

describe("keyMode with OAuth tokens", () => {
  it("keeps key prefixes and treats other tokens as live", () => {
    expect(keyMode("sk_live_x")).toBe("live");
    expect(keyMode("rk_live_x")).toBe("live");
    expect(keyMode("sk_test_x")).toBe("test");
    expect(keyMode("rk_test_x")).toBe("test");
    expect(keyMode("stripe-app-access")).toBe("live");
    expect(dashboardUrl("stripe-app-access", "/products")).toBe(
      "https://dashboard.stripe.com/products",
    );
  });
});
