import { describe, expect, it, vi } from "vitest";
import type { OAuthDeclaration } from "@infrawrench/plugin-base";
import {
  OAuthReconnectRequiredError,
  OAuthRefreshUnavailableError,
  createLocalOAuthRefresher,
  mergeIncomingCredentials,
  oauthStatusFor,
  redactGrantForRenderer,
  type LocalOAuthHost,
} from "../provider-oauth/credentials";
import {
  deliverToPendingFlow,
  parseProviderOAuthDeepLink,
  type ProviderOAuthPayload,
} from "../provider-oauth/deep-link";
import { LoopbackFlowError, runLoopbackAuthorization } from "../provider-oauth/loopback";

const declaration: OAuthDeclaration = {
  authorizeUrl: "https://provider.test/oauth/authorize",
  tokenUrl: "https://provider.test/oauth/token",
  scopes: ["read"],
  tokenField: "apiToken",
  clients: { desktop: {} },
  access: "read-only",
  refresh: "rotating",
};

const NOW = 1_800_000_000_000;

function grant(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    client: "desktop",
    refreshToken: "rt-1",
    expiresAt: NOW + 60 * 60 * 1000,
    connectedAt: 1000,
    ...extra,
  });
}

describe("redactGrantForRenderer", () => {
  it("removes only the refresh token", () => {
    const out = redactGrantForRenderer({ apiToken: "at", __oauth: grant() });
    expect(out["apiToken"]).toBe("at");
    const state = JSON.parse(out["__oauth"]!) as Record<string, unknown>;
    expect(state["refreshToken"]).toBeUndefined();
    expect(state["connectedAt"]).toBe(1000);
  });

  it("leaves a pasted credential alone", () => {
    const creds = { apiToken: "pasted" };
    expect(redactGrantForRenderer(creds)).toBe(creds);
  });
});

describe("mergeIncomingCredentials", () => {
  const stored = { apiToken: "at-2", region: "eu", __oauth: grant() };

  it("keeps the stored grant when a picker changes and __oauth is absent", () => {
    const out = mergeIncomingCredentials({ apiToken: "at-2", region: "us" }, stored, "apiToken");
    expect(out).toEqual({ apiToken: "at-2", region: "us", __oauth: stored.__oauth });
  });

  it("keeps the stored grant and token when the renderer's token is a stale issued one", () => {
    const out = mergeIncomingCredentials(
      { apiToken: "at-1", region: "us" },
      stored,
      "apiToken",
      new Set(["at-1"]),
    );
    expect(out).toEqual({ apiToken: "at-2", region: "us", __oauth: stored.__oauth });
  });

  it("recognises its own redacted copy coming back", () => {
    const redacted = redactGrantForRenderer({ apiToken: "at-old", __oauth: grant() });
    const out = mergeIncomingCredentials({ ...redacted, region: "us" }, stored, "apiToken");
    expect(out["apiToken"]).toBe("at-2");
    expect(out["__oauth"]).toBe(stored.__oauth);
  });

  it("drops the grant when the user pastes a different token", () => {
    const out = mergeIncomingCredentials({ apiToken: "pasted", region: "eu" }, stored, "apiToken");
    expect(out).toEqual({ apiToken: "pasted", region: "eu" });
    expect(oauthStatusFor(out)).toBeNull();
  });

  it("takes a fresh grant from a reconnect", () => {
    const fresh = grant({ refreshToken: "rt-new", connectedAt: 5000 });
    const out = mergeIncomingCredentials(
      { apiToken: "at-new", region: "eu", __oauth: fresh },
      stored,
      "apiToken",
    );
    expect(out["__oauth"]).toBe(fresh);
    expect(out["apiToken"]).toBe("at-new");
  });

  it("drops a malformed __oauth on create", () => {
    expect(
      mergeIncomingCredentials({ apiToken: "x", __oauth: "sealed-or-junk" }, undefined, undefined),
    ).toEqual({
      apiToken: "x",
    });
  });

  it("keeps a well-formed grant on create", () => {
    const creds = { apiToken: "x", __oauth: grant() };
    expect(mergeIncomingCredentials(creds, undefined, undefined)).toBe(creds);
    expect(oauthStatusFor(creds)).toBe("connected");
  });
});

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeHost(initial: Record<string, string>, overrides: Partial<LocalOAuthHost> = {}) {
  let stored = { ...initial };
  const saves: Array<Record<string, string>> = [];
  const statuses: string[] = [];
  const host: LocalOAuthHost = {
    getProvider: async () => ({ declaration, displayName: "Provider" }),
    getClientId: () => "client-123",
    load: async () => ({ ...stored }),
    save: async (_id, creds) => {
      stored = { ...creds };
      saves.push(creds);
    },
    setStatus: async (_id, status) => {
      statuses.push(status);
    },
    canPersist: () => true,
    fetch: vi.fn<typeof fetch>(),
    now: () => NOW,
    ...overrides,
  };
  return { host, saves, statuses, current: () => stored };
}

describe("createLocalOAuthRefresher", () => {
  const expiring = { apiToken: "at-1", __oauth: grant({ expiresAt: NOW + 1000 }) };

  it("returns a pasted credential untouched without loading anything", async () => {
    const { host } = makeHost({ apiToken: "pasted" });
    const refresher = createLocalOAuthRefresher(host);
    const creds = { apiToken: "pasted" };
    expect(await refresher.resolve("a", "p", creds)).toBe(creds);
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it("does not refresh a token that is still valid", async () => {
    const { host } = makeHost({ apiToken: "at-1", __oauth: grant() });
    const refresher = createLocalOAuthRefresher(host);
    await refresher.resolve("a", "p", { apiToken: "at-1", __oauth: grant() });
    expect(host.fetch).not.toHaveBeenCalled();
    expect(refresher.issuedTokens("a").has("at-1")).toBe(true);
  });

  it("refreshes once for concurrent callers and writes the rotation back", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      tokenResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
    );
    const { host, saves, current } = makeHost(expiring, { fetch: fetchMock });
    const refresher = createLocalOAuthRefresher(host);
    const [a, b] = await Promise.all([
      refresher.resolve("a", "p", expiring),
      refresher.resolve("a", "p", expiring),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String(fetchMock.mock.calls[0]![1]!.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt-1");
    expect(body).toContain("client_id=client-123");
    expect(body).not.toContain("client_secret");
    expect(a["apiToken"]).toBe("at-2");
    expect(b["apiToken"]).toBe("at-2");
    expect(saves).toHaveLength(1);
    const state = JSON.parse(current()["__oauth"]!) as Record<string, unknown>;
    expect(state["refreshToken"]).toBe("rt-2");
    expect(state["connectedAt"]).toBe(1000);
  });

  it("re-reads inside the flight so a stale caller does not reuse a rotated token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    // Storage already holds the refreshed grant; the caller decrypted before that.
    const { host } = makeHost(
      { apiToken: "at-2", __oauth: grant({ refreshToken: "rt-2" }) },
      { fetch: fetchMock },
    );
    const refresher = createLocalOAuthRefresher(host);
    const out = await refresher.resolve("a", "p", expiring);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out["apiToken"]).toBe("at-2");
  });

  it("marks reconnect_required when the grant is rejected", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      tokenResponse({ error: "invalid_grant" }, 400),
    );
    const { host, statuses, saves } = makeHost(expiring, { fetch: fetchMock });
    const refresher = createLocalOAuthRefresher(host);
    await expect(refresher.resolve("a", "p", expiring)).rejects.toBeInstanceOf(
      OAuthReconnectRequiredError,
    );
    expect(statuses).toEqual(["reconnect_required"]);
    expect(saves).toHaveLength(0);
  });

  it("leaves the status alone on a transient failure", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      tokenResponse({ error: "temporarily_unavailable" }, 503),
    );
    const { host, statuses } = makeHost(expiring, { fetch: fetchMock });
    const refresher = createLocalOAuthRefresher(host);
    await expect(refresher.resolve("a", "p", expiring)).rejects.toThrow();
    expect(statuses).toEqual([]);
  });

  it("refuses to spend a rotating refresh token it cannot persist", async () => {
    const { host } = makeHost(expiring, { canPersist: () => false });
    const refresher = createLocalOAuthRefresher(host);
    await expect(refresher.resolve("a", "p", expiring)).rejects.toBeInstanceOf(
      OAuthRefreshUnavailableError,
    );
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it("never refreshes a server-issued grant", async () => {
    const serverGrant = { apiToken: "x", __oauth: grant({ client: "server", expiresAt: NOW }) };
    const { host } = makeHost(serverGrant);
    const refresher = createLocalOAuthRefresher(host);
    expect(await refresher.resolve("a", "p", serverGrant)).toBe(serverGrant);
    expect(host.fetch).not.toHaveBeenCalled();
  });
});

function encodePayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("parseProviderOAuthDeepLink", () => {
  it("decodes a successful result", () => {
    const url = `infrawrench://provider-oauth?payload=${encodePayload({
      type: "infrawrench:provider-oauth",
      ok: true,
      pluginId: "github",
      credentials: { apiToken: "at", __oauth: "sealed" },
      accountName: "octo",
    })}`;
    expect(parseProviderOAuthDeepLink(url)).toEqual({
      type: "infrawrench:provider-oauth",
      ok: true,
      pluginId: "github",
      credentials: { apiToken: "at", __oauth: "sealed" },
      accountName: "octo",
    });
  });

  it("rejects a success without a sealed grant", () => {
    const url = `infrawrench://provider-oauth?payload=${encodePayload({
      type: "infrawrench:provider-oauth",
      ok: true,
      pluginId: "github",
      credentials: { apiToken: "attacker" },
    })}`;
    expect(parseProviderOAuthDeepLink(url)).toBeNull();
  });

  it("rejects other hosts and junk", () => {
    expect(parseProviderOAuthDeepLink("infrawrench://callback?code=x")).toBeNull();
    expect(parseProviderOAuthDeepLink("infrawrench://provider-oauth?payload=%%%")).toBeNull();
  });

  it("only delivers to the flow that is waiting", () => {
    const resolve = vi.fn();
    const payload: ProviderOAuthPayload = {
      type: "infrawrench:provider-oauth",
      ok: false,
      pluginId: "github",
      error: "denied",
    };
    expect(deliverToPendingFlow(null, payload)).toBe(false);
    expect(deliverToPendingFlow({ pluginId: "gitlab", resolve }, payload)).toBe(false);
    expect(deliverToPendingFlow({ pluginId: "github", resolve }, payload)).toBe(true);
    expect(resolve).toHaveBeenCalledWith(payload);
  });
});

describe("runLoopbackAuthorization", () => {
  const port = 43200 + Math.floor(Math.random() * 500);

  it("validates state, hands the code over and closes the listener", async () => {
    let authorizeUrl = "";
    const onCode = vi.fn(
      async (args: { code: string; codeVerifier: string; redirectUri: string }) => {
        return `token-for-${args.code}`;
      },
    );
    const flow = runLoopbackAuthorization({
      declaration,
      client: { clientId: "client-123" },
      providerName: "Provider",
      port,
      openExternal: (url) => {
        authorizeUrl = url;
      },
      onCode,
    });
    await vi.waitFor(() => expect(authorizeUrl).not.toBe(""));
    const authorize = new URL(authorizeUrl);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${port}/oauth/callback`,
    );
    const state = authorize.searchParams.get("state")!;

    const forged = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=evil&state=wrong`);
    expect(forged.status).toBe(400);
    expect(onCode).not.toHaveBeenCalled();

    const ok = await fetch(
      `http://127.0.0.1:${port}/oauth/callback?code=good&state=${encodeURIComponent(state)}`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Connected to Provider");
    await expect(flow).resolves.toBe("token-for-good");
    expect(onCode.mock.calls[0]![0].codeVerifier.length).toBeGreaterThan(40);

    await expect(fetch(`http://127.0.0.1:${port}/oauth/callback`)).rejects.toThrow();
  });

  it("rejects on a provider error with the valid state", async () => {
    let authorizeUrl = "";
    const flow = runLoopbackAuthorization({
      declaration,
      client: { clientId: "c" },
      providerName: "Provider",
      port: port + 1,
      openExternal: (url) => {
        authorizeUrl = url;
      },
      onCode: async () => "never",
    });
    await vi.waitFor(() => expect(authorizeUrl).not.toBe(""));
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const outcome = expect(flow).rejects.toMatchObject({ reason: "denied" });
    await fetch(
      `http://127.0.0.1:${port + 1}/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    await outcome;
  });

  it("can be cancelled and times out", async () => {
    const controller = new AbortController();
    const cancelled = runLoopbackAuthorization({
      declaration,
      client: { clientId: "c" },
      providerName: "Provider",
      port: port + 2,
      signal: controller.signal,
      openExternal: () => controller.abort(),
      onCode: async () => "never",
    });
    await expect(cancelled).rejects.toBeInstanceOf(LoopbackFlowError);

    const timedOut = runLoopbackAuthorization({
      declaration,
      client: { clientId: "c" },
      providerName: "Provider",
      port: port + 3,
      timeoutMs: 50,
      openExternal: () => undefined,
      onCode: async () => "never",
    });
    await expect(timedOut).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("client registration modes", () => {
  it("refreshes a dynamically registered grant with its own client id", async () => {
    const creds = {
      apiToken: "at-1",
      __oauth: grant({ expiresAt: NOW + 1000, clientId: "dyn-client" }),
    };
    const fetchMock = vi.fn<typeof fetch>(async () =>
      tokenResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
    );
    const { host, current } = makeHost(creds, {
      fetch: fetchMock,
      getClientId: () => undefined,
    });
    await createLocalOAuthRefresher(host).resolve("a", "p", creds);
    expect(String(fetchMock.mock.calls[0]![1]!.body)).toContain("client_id=dyn-client");
    const state = JSON.parse(current()["__oauth"]!) as Record<string, unknown>;
    expect(state["clientId"]).toBe("dyn-client");
  });

  it("registers the client with the redirect URI and uses the plugin's URL builder", async () => {
    const port = 43800 + Math.floor(Math.random() * 100);
    let opened = "";
    const register = vi.fn(async (redirectUri: string) => ({
      clientId: `registered-for-${redirectUri}`,
    }));
    const flow = runLoopbackAuthorization({
      declaration: { ...declaration, clientRegistration: "dynamic" },
      client: register,
      buildAuthorizeUrl: (p) =>
        `https://provider.test/custom?callback_url=${encodeURIComponent(p.redirectUri)}&state=${p.state}&cid=${encodeURIComponent(p.clientId)}`,
      providerName: "Provider",
      port,
      openExternal: (url) => {
        opened = url;
      },
      onCode: async ({ client }) => client.clientId,
    });
    await vi.waitFor(() => expect(opened).not.toBe(""));
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    expect(register).toHaveBeenCalledWith(redirectUri);
    const url = new URL(opened);
    expect(url.pathname).toBe("/custom");
    expect(url.searchParams.get("cid")).toBe(`registered-for-${redirectUri}`);
    await fetch(
      `${redirectUri}?code=c&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
    );
    await expect(flow).resolves.toBe(`registered-for-${redirectUri}`);
  });
});
