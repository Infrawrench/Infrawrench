import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOAuthAuthorizeUrl,
  desktopOAuthRedirectUri,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { CLOUDFLARE_OAUTH_SCOPES, completeCloudflareOAuth } from "../oauth.js";
import { runCloudflarePreflight } from "../preflight.js";
import { BillingTokenError, withBillingToken } from "../billing-token.js";

vi.mock("../billing-token.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing-token.js")>();
  return { ...actual, withBillingToken: vi.fn() };
});

const TOKENS: OAuthTokenSet = { accessToken: "cf-oauth-access", raw: {} };
const envelope = (result: unknown) => ({ success: true, result, errors: [] });

function routes(map: Record<string, { status: number; body: unknown }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, r] of Object.entries(map)) {
      if (url.includes(needle)) return new Response(JSON.stringify(r.body), { status: r.status });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare OAuth declaration", () => {
  const decl = plugin.manifest.oauth!;

  it("fills the existing API token field", () => {
    expect(decl.tokenField).toBe("apiToken");
    expect(plugin.manifest.credentialFields.map((f) => f.key)).toContain("apiToken");
  });

  it("declares a confidential server client and a loopback desktop client", () => {
    expect(decl.clients.server?.auth).toBe("client_secret_basic");
    expect(desktopOAuthRedirectUri(decl)).toBe("http://127.0.0.1:43118/oauth/callback");
  });

  it("requests dotted scope IDs plus offline_access for a refresh token", () => {
    expect(CLOUDFLARE_OAUTH_SCOPES).toContain("offline_access");
    expect(CLOUDFLARE_OAUTH_SCOPES).toContain("dns.write");
    expect(CLOUDFLARE_OAUTH_SCOPES).toContain("workers-scripts.write");
    // Costs mint a Billing Read token: OAuth has no billing scope.
    expect(CLOUDFLARE_OAUTH_SCOPES).toContain("account-api-tokens.write");
    expect(CLOUDFLARE_OAUTH_SCOPES.some((s) => s.startsWith("billing"))).toBe(false);
    expect(new Set(CLOUDFLARE_OAUTH_SCOPES).size).toBe(CLOUDFLARE_OAUTH_SCOPES.length);
    for (const s of CLOUDFLARE_OAUTH_SCOPES) {
      if (s !== "offline_access") expect(s).toMatch(/^[a-z0-9-]+\.(read|write|purge)$/);
    }
  });

  it("builds the authorize URL on dash.cloudflare.com", () => {
    const url = new URL(
      buildOAuthAuthorizeUrl(decl, {
        clientId: "cid",
        redirectUri: "http://127.0.0.1:43118/oauth/callback",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url.searchParams.get("scope")).toBe(CLOUDFLARE_OAUTH_SCOPES.join(" "));
  });
});

describe("completeCloudflareOAuth", () => {
  it("names the account after the single granted Cloudflare account", async () => {
    const fetchMock = routes({
      "/accounts": { status: 200, body: envelope([{ id: "a1", name: "Acme Corp" }]) },
    });
    const res = await completeCloudflareOAuth(TOKENS, {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "Acme Corp" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer cf-oauth-access",
    );
  });

  it("uses the user's email when several accounts were granted", async () => {
    const fetchMock = routes({
      "/accounts": {
        status: 200,
        body: envelope([
          { id: "a1", name: "One" },
          { id: "a2", name: "Two" },
        ]),
      },
      "/user": { status: 200, body: envelope({ email: "ops@example.com" }) },
    });
    const res = await completeCloudflareOAuth(TOKENS, {
      client: "desktop",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({ accountName: "ops@example.com" });
  });

  it("returns nothing when both lookups fail", async () => {
    const fetchMock = routes({
      "/accounts": { status: 403, body: { success: false } },
      "/user": { status: 403, body: { success: false } },
    });
    const res = await completeCloudflareOAuth(TOKENS, {
      client: "server",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res).toEqual({});
  });
});

describe("runCloudflarePreflight with an OAuth token", () => {
  const baseRoutes = {
    "/zones?per_page=1": { status: 200, body: envelope([]) },
    "/accounts?per_page=1": { status: 200, body: envelope([{ id: "acc1" }]) },
    "/graphql": { status: 200, body: { data: { viewer: { budget: 1 } } } },
  };

  it("skips the API-token verify call and probes billing through a minted token", async () => {
    const fetchMock = routes({
      ...baseRoutes,
      "/billable-usage/info": { status: 200, body: envelope({ covered: true }) },
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(withBillingToken).mockImplementationOnce(async (_api, accountId, fn) => {
      expect(accountId).toBe("acc1");
      return fn({ apiToken: "minted" } as Parameters<typeof fn>[0]);
    });
    const res = await runCloudflarePreflight("cf-oauth-access", { oauth: true });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/user/tokens/verify"))).toBe(
      false,
    );
    expect(res.identity).toBe("OAuth connection");
    expect(res.checks.find((c) => c.capabilityId === "costs")?.status).toBe("ok");
    expect(res.checks.find((c) => c.capabilityId === "resources")?.status).toBe("ok");
    const infoCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/billable-usage"));
    const init = (infoCall as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer minted");
  });

  it("names Account API Tokens Write when the grant cannot mint", async () => {
    vi.stubGlobal("fetch", routes(baseRoutes));
    vi.mocked(withBillingToken).mockRejectedValueOnce(
      new BillingTokenError("this connection was not granted Account API Tokens Write", "scope"),
    );
    const res = await runCloudflarePreflight("cf-oauth-access", { oauth: true });
    const costs = res.checks.find((c) => c.capabilityId === "costs")!;
    expect(costs.status).toBe("missing");
    expect(costs.status === "missing" ? costs.missingPermissions.map((p) => p.id) : []).toEqual([
      "Account API Tokens Write",
    ]);
  });
});
