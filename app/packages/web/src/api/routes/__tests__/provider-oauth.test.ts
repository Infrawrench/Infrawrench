import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "./test-utils";

const mockGetPlugin = vi.fn();
const pluginLoaderMock = {
  getPlugin: (...a: unknown[]) => mockGetPlugin(...a),
  loadPlugins: vi.fn(),
};
vi.mock("@/plugins/loader", () => pluginLoaderMock);
vi.mock("@infrawrench/server-core/plugin-loader", () => pluginLoaderMock);
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@infrawrench/server-core/db/client", () => ({ db: {} }));

const { providerOAuthRoutes, providerOAuthCallbackRoute, renderPopupResultPage } =
  await import("@/api/routes/provider-oauth");
const { unsealGrant, unsealState } = await import("@infrawrench/server-core/provider-oauth");

const manifest = {
  id: "acme",
  displayName: "Acme",
  credentialFields: [],
  oauth: {
    authorizeUrl: "https://acme.example/authorize",
    tokenUrl: "https://acme.example/token",
    scopes: ["read"],
    tokenField: "token",
    clients: { server: { pkce: true } },
    access: "read-only",
    refresh: "rotating",
  },
};

beforeAll(() => {
  process.env["ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");
  process.env["APP_URL"] = "https://app.example.com";
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env["PROVIDER_OAUTH_ACME_CLIENT_ID"] = "cid";
  process.env["PROVIDER_OAUTH_ACME_CLIENT_SECRET"] = "csecret";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function authorize(
  plugin: Record<string, unknown>,
  returnTo: "web" | "desktop",
): Promise<URL> {
  mockGetPlugin.mockResolvedValue({ plugin });
  const res = await buildTestApp(providerOAuthRoutes).request("/acme/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnTo }),
  });
  expect(res.status).toBe(200);
  return new URL(((await res.json()) as { url: string }).url);
}

function stubTokenEndpoint() {
  const doFetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      ),
  );
  vi.stubGlobal("fetch", doFetch);
  return doFetch;
}

describe("provider OAuth routes", () => {
  it("builds the authorize URL with a sealed state carrying the PKCE verifier", async () => {
    const url = await authorize({ manifest }, "web");
    expect(url.origin + url.pathname).toBe("https://acme.example/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/provider-oauth/acme/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = await unsealState(url.searchParams.get("state")!);
    expect(state).toMatchObject({ orgId: "org-1", userId: "user-1", pluginId: "acme" });
    expect(state?.codeVerifier).toBeTruthy();
  });

  it("refuses when the server has no client configured", async () => {
    delete process.env["PROVIDER_OAUTH_ACME_CLIENT_SECRET"];
    mockGetPlugin.mockResolvedValue({ plugin: { manifest } });
    const res = await buildTestApp(providerOAuthRoutes).request("/acme/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnTo: "web" }),
    });
    expect(res.status).toBe(400);
  });

  it("uses a dynamically registered client and the plugin's authorize URL hook", async () => {
    delete process.env["PROVIDER_OAUTH_ACME_CLIENT_ID"];
    delete process.env["PROVIDER_OAUTH_ACME_CLIENT_SECRET"];
    const registerOAuthClient = vi.fn(async () => ({ clientId: "dyn", clientSecret: "dyn-s" }));
    const buildOAuthAuthorizeUrl = vi.fn(
      (p: { clientId: string; state: string }) =>
        `https://acme.example/custom?cid=${p.clientId}&state=${p.state}`,
    );
    const url = await authorize(
      {
        manifest: { ...manifest, oauth: { ...manifest.oauth, clientRegistration: "dynamic" } },
        registerOAuthClient,
        buildOAuthAuthorizeUrl,
      },
      "web",
    );
    expect(url.searchParams.get("cid")).toBe("dyn");
    const state = await unsealState(url.searchParams.get("state")!);
    expect(state?.registeredClient).toEqual({ clientId: "dyn", clientSecret: "dyn-s" });
  });

  it("posts a sealed grant to the opener for web flows", async () => {
    const completeOAuthConnection = vi.fn(async () => ({
      credentials: { accountId: "acct-9", token: "ignored" },
      accountName: "Acme Prod",
    }));
    const plugin = { manifest, completeOAuthConnection };
    const authUrl = await authorize(plugin, "web");
    const doFetch = stubTokenEndpoint();

    const res = await buildTestApp(providerOAuthCallbackRoute).request(
      `/provider-oauth/acme/callback?code=c1&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`,
    );
    expect(res.status).toBe(200);
    const body = new URLSearchParams(String(doFetch.mock.calls[0]![1]!.body));
    expect(body.get("code")).toBe("c1");
    expect(body.get("code_verifier")).toBeTruthy();
    const html = await res.text();
    expect(html).toContain("window.opener.postMessage(payload, origin)");
    expect(html).toContain('"https://app.example.com"');
    expect(html).not.toContain("rt-1");
    const payload = JSON.parse(/var payload = (.*);/.exec(html)![1]!);
    expect(payload).toMatchObject({
      type: "infrawrench:provider-oauth",
      ok: true,
      pluginId: "acme",
      accountName: "Acme Prod",
      credentials: { token: "at-1", accountId: "acct-9" },
    });
    const grant = await unsealGrant(payload.credentials.__oauth);
    expect(grant).toMatchObject({ orgId: "org-1", userId: "user-1", pluginId: "acme" });
    expect(grant?.tokens.refreshToken).toBe("rt-1");
  });

  it("redirects desktop flows to the deep link", async () => {
    const authUrl = await authorize({ manifest }, "desktop");
    stubTokenEndpoint();
    const res = await buildTestApp(providerOAuthCallbackRoute).request(
      `/provider-oauth/acme/callback?code=c1&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.protocol + location.host).toBe("infrawrench:provider-oauth");
    const payload = JSON.parse(
      Buffer.from(location.searchParams.get("payload")!, "base64url").toString("utf8"),
    );
    expect(payload).toMatchObject({ ok: true, credentials: { token: "at-1" } });
  });

  it("reports a cancelled consent", async () => {
    const authUrl = await authorize({ manifest }, "desktop");
    const res = await buildTestApp(providerOAuthCallbackRoute).request(
      `/provider-oauth/acme/callback?error=access_denied&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`,
    );
    const location = new URL(res.headers.get("location")!);
    const payload = JSON.parse(
      Buffer.from(location.searchParams.get("payload")!, "base64url").toString("utf8"),
    );
    expect(payload).toMatchObject({ ok: false, pluginId: "acme" });
  });

  it("rejects a forged or foreign state", async () => {
    const res = await buildTestApp(providerOAuthCallbackRoute).request(
      "/provider-oauth/acme/callback?code=c1&state=forged.state",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ok":false');
  });

  it("escapes script-breaking characters in the popup page", () => {
    const html = renderPopupResultPage(
      {
        type: "infrawrench:provider-oauth",
        ok: false,
        pluginId: "acme",
        error: "</script><script>alert(1)</script>",
      },
      "https://app.example.com",
    );
    expect(html).not.toContain("</script><script>alert(1)");
  });
});
