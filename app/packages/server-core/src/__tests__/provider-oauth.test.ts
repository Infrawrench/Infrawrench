import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OAUTH_CREDENTIAL_KEY,
  readOAuthGrantState,
  type OAuthGrantState,
  type PluginManifest,
} from "@infrawrench/plugin-base";

vi.mock("../db/client", () => ({ db: {} }));

import {
  GRANT_TTL_MS,
  OAuthCredentialError,
  OAuthReconnectRequiredError,
  acceptSubmittedCredentials,
  pluginOAuthSummary,
  providerOAuthRedirectUri,
  resetOAuthRefreshStateForTests,
  resolveCredentialUpdate,
  resolveOAuthCredentials,
  sealGrant,
  sealState,
  sealValue,
  unsealGrant,
  unsealState,
  updateAccountCredentials,
  type AccountCredentialStore,
  type ProviderOAuthGrant,
} from "../provider-oauth";

const manifest = {
  id: "acme-cloud",
  displayName: "Acme Cloud",
  oauth: {
    authorizeUrl: "https://acme.example/oauth/authorize",
    tokenUrl: "https://acme.example/oauth/token",
    scopes: ["read"],
    tokenField: "apiToken",
    clients: { server: {} },
    access: "read-only",
    refresh: "rotating",
  },
} as unknown as PluginManifest;

const ORG = "org-1";
const USER = "user-1";

beforeAll(() => {
  process.env["ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");
});

function grant(overrides: Partial<ProviderOAuthGrant> = {}): ProviderOAuthGrant {
  return {
    orgId: ORG,
    userId: USER,
    pluginId: "acme-cloud",
    client: "server",
    tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 },
    exp: Date.now() + GRANT_TTL_MS,
    ...overrides,
  };
}

const ctx = { manifest, organizationId: ORG, userId: USER };

describe("sealing", () => {
  it("round-trips state and grants", async () => {
    const state = {
      orgId: ORG,
      userId: USER,
      pluginId: "acme-cloud",
      returnTo: "web" as const,
      codeVerifier: "v",
      nonce: "n",
      exp: Date.now() + 60_000,
    };
    const sealed = await sealState(state);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await unsealState(sealed)).toEqual(state);
    const g = grant();
    expect(await unsealGrant(await sealGrant(g))).toEqual(g);
  });

  it("does not leak the refresh token in the sealed text", async () => {
    const sealed = await sealGrant(grant());
    expect(sealed).not.toContain("rt-1");
    expect(Buffer.from(sealed.split(".")[1]!, "base64url").toString()).not.toContain("rt-1");
  });

  it("rejects expired values", async () => {
    expect(await unsealGrant(await sealGrant(grant({ exp: Date.now() - 1 })))).toBeNull();
  });

  it("rejects a state replayed as a grant and vice versa", async () => {
    const sealedGrant = await sealGrant(grant());
    expect(await unsealState(sealedGrant)).toBeNull();
    const sealedState = await sealState({
      orgId: ORG,
      userId: USER,
      pluginId: "acme-cloud",
      returnTo: "web",
      nonce: "n",
      exp: Date.now() + 60_000,
    });
    expect(await unsealGrant(sealedState)).toBeNull();
  });

  it("rejects tampered and malformed values", async () => {
    const sealed = await sealGrant(grant());
    const [iv, ct] = sealed.split(".");
    const flipped = ct!.slice(0, -2) + (ct!.endsWith("A") ? "BB" : "AA");
    expect(await unsealGrant(`${iv}.${flipped}`)).toBeNull();
    expect(await unsealGrant("not-sealed")).toBeNull();
    expect(await unsealGrant('{"v":1}')).toBeNull();
    expect(await unsealGrant(await sealValue({ hello: "x" }, "provider-oauth:grant"))).toBeNull();
  });
});

describe("configuration", () => {
  afterEach(() => {
    delete process.env["PROVIDER_OAUTH_ACME_CLOUD_CLIENT_ID"];
    delete process.env["PROVIDER_OAUTH_ACME_CLOUD_CLIENT_SECRET"];
    delete process.env["APP_URL"];
  });

  it("exposes the listing summary only when id and secret are configured", () => {
    expect(pluginOAuthSummary(manifest)).toBeUndefined();
    process.env["PROVIDER_OAUTH_ACME_CLOUD_CLIENT_ID"] = "id";
    expect(pluginOAuthSummary(manifest)).toBeUndefined();
    process.env["PROVIDER_OAUTH_ACME_CLOUD_CLIENT_SECRET"] = "secret";
    expect(pluginOAuthSummary(manifest)).toEqual({
      access: "read-only",
      refresh: "rotating",
      tokenField: "apiToken",
      clients: ["server"],
    });
  });

  it("hides desktop-only declarations", () => {
    process.env["PROVIDER_OAUTH_ACME_CLOUD_CLIENT_ID"] = "id";
    process.env["PROVIDER_OAUTH_ACME_CLOUD_CLIENT_SECRET"] = "secret";
    const desktopOnly = {
      ...manifest,
      oauth: { ...manifest.oauth!, clients: { desktop: {} } },
    } as PluginManifest;
    expect(pluginOAuthSummary(desktopOnly)).toBeUndefined();
  });

  it("derives the redirect URI from APP_URL", () => {
    process.env["APP_URL"] = "https://app.example.com/";
    expect(providerOAuthRedirectUri("acme-cloud")).toBe(
      "https://app.example.com/api/provider-oauth/acme-cloud/callback",
    );
  });
});

describe("acceptSubmittedCredentials", () => {
  it("passes pasted credentials through", async () => {
    const out = await acceptSubmittedCredentials({ apiToken: "pasted" }, ctx);
    expect(out).toEqual({ credentials: { apiToken: "pasted" }, oauthStatus: null });
  });

  it("opens a sealed grant into real grant state", async () => {
    const sealed = await sealGrant(grant());
    const out = await acceptSubmittedCredentials(
      { apiToken: "whatever-the-browser-sent", region: "eu", [OAUTH_CREDENTIAL_KEY]: sealed },
      ctx,
    );
    expect(out.oauthStatus).toBe("connected");
    expect(out.credentials["apiToken"]).toBe("at-1");
    expect(out.credentials["region"]).toBe("eu");
    const state = readOAuthGrantState(out.credentials);
    expect(state).toMatchObject({ v: 1, client: "server", refreshToken: "rt-1" });
  });

  it.each([
    ["another org", { orgId: "org-2" }],
    ["another user", { userId: "user-2" }],
    ["another plugin", { pluginId: "other" }],
    ["an expired grant", { exp: Date.now() - 1 }],
  ])("rejects a grant for %s", async (_label, overrides) => {
    const sealed = await sealGrant(grant(overrides as Partial<ProviderOAuthGrant>));
    await expect(
      acceptSubmittedCredentials({ apiToken: "x", [OAUTH_CREDENTIAL_KEY]: sealed }, ctx),
    ).rejects.toBeInstanceOf(OAuthCredentialError);
  });

  it("rejects raw grant state planted by a client", async () => {
    const raw = JSON.stringify({ v: 1, client: "server", refreshToken: "evil", connectedAt: 1 });
    await expect(
      acceptSubmittedCredentials({ apiToken: "x", [OAUTH_CREDENTIAL_KEY]: raw }, ctx),
    ).rejects.toBeInstanceOf(OAuthCredentialError);
  });

  it("rejects a grant for a plugin without OAuth", async () => {
    const sealed = await sealGrant(grant());
    await expect(
      acceptSubmittedCredentials(
        { apiToken: "x", [OAUTH_CREDENTIAL_KEY]: sealed },
        { ...ctx, manifest: { ...manifest, oauth: undefined } as unknown as PluginManifest },
      ),
    ).rejects.toBeInstanceOf(OAuthCredentialError);
  });

  it("drops an empty __oauth", async () => {
    const out = await acceptSubmittedCredentials(
      { apiToken: "p", [OAUTH_CREDENTIAL_KEY]: "" },
      ctx,
    );
    expect(out.credentials).toEqual({ apiToken: "p" });
  });
});

describe("resolveCredentialUpdate (PUT preservation)", () => {
  const storedGrant: OAuthGrantState = {
    v: 1,
    client: "server",
    refreshToken: "rt-stored",
    expiresAt: Date.now() + 3_600_000,
    connectedAt: 1,
  };
  const stored = {
    apiToken: "at-stored",
    accountId: "a1",
    [OAUTH_CREDENTIAL_KEY]: JSON.stringify(storedGrant),
  };
  const putCtx = { ...ctx, currentStatus: "connected" as const };

  it("keeps the grant when the token field is absent", async () => {
    const out = await resolveCredentialUpdate({ accountId: "a2" }, stored, putCtx);
    expect(out.oauthStatus).toBe("connected");
    expect(out.credentials).toEqual({
      accountId: "a2",
      apiToken: "at-stored",
      [OAUTH_CREDENTIAL_KEY]: stored[OAUTH_CREDENTIAL_KEY],
    });
  });

  it("keeps the grant when the token is unchanged", async () => {
    const out = await resolveCredentialUpdate(
      { apiToken: "at-stored", accountId: "a2" },
      stored,
      putCtx,
    );
    expect(readOAuthGrantState(out.credentials)?.refreshToken).toBe("rt-stored");
  });

  it("keeps a reconnect_required status rather than claiming connected", async () => {
    const out = await resolveCredentialUpdate({ accountId: "a2" }, stored, {
      ...ctx,
      currentStatus: "reconnect_required",
    });
    expect(out.oauthStatus).toBe("reconnect_required");
  });

  it("drops the grant when the user pastes a different token", async () => {
    const out = await resolveCredentialUpdate(
      { apiToken: "pasted", accountId: "a1" },
      stored,
      putCtx,
    );
    expect(out).toEqual({
      credentials: { apiToken: "pasted", accountId: "a1" },
      oauthStatus: null,
    });
  });

  it("replaces the grant on reconnect", async () => {
    const sealed = await sealGrant(
      grant({ tokens: { accessToken: "at-new", refreshToken: "rt-new" } }),
    );
    const out = await resolveCredentialUpdate(
      { apiToken: "at-new", accountId: "a1", [OAUTH_CREDENTIAL_KEY]: sealed },
      stored,
      { ...ctx, currentStatus: "reconnect_required" },
    );
    expect(out.oauthStatus).toBe("connected");
    expect(readOAuthGrantState(out.credentials)?.refreshToken).toBe("rt-new");
  });

  it("leaves pasted accounts alone", async () => {
    const out = await resolveCredentialUpdate({ apiToken: "b" }, { apiToken: "a" }, putCtx);
    expect(out).toEqual({ credentials: { apiToken: "b" }, oauthStatus: null });
  });
});

/** In-memory store with a real mutex, so concurrency is exercised. */
function fakeStore(initial: Record<string, string>) {
  let credentials = { ...initial };
  let status: string | null = "connected";
  let lock: Promise<void> = Promise.resolve();
  const writes: Record<string, string>[] = [];
  const store: AccountCredentialStore = {
    async withLockedCredentials(_id, _org, fn) {
      const previous = lock;
      let release!: () => void;
      lock = new Promise((r) => (release = r));
      await previous;
      try {
        const { result, write } = await fn({ ...credentials });
        if (write) {
          credentials = { ...write.credentials };
          writes.push(credentials);
          if (write.oauthStatus !== undefined) status = write.oauthStatus;
        }
        return result;
      } finally {
        release();
      }
    },
    async setOAuthStatus(_id, _org, s) {
      status = s;
    },
  };
  return {
    store,
    writes,
    get credentials() {
      return credentials;
    },
    get status() {
      return status;
    },
  };
}

function grantCredentials(expiresAt: number, refreshToken = "rt-1") {
  return {
    apiToken: "at-old",
    [OAUTH_CREDENTIAL_KEY]: JSON.stringify({
      v: 1,
      client: "server",
      refreshToken,
      expiresAt,
      connectedAt: 1,
    } satisfies OAuthGrantState),
  };
}

describe("resolveOAuthCredentials", () => {
  beforeEach(() => {
    resetOAuthRefreshStateForTests();
    process.env["PROVIDER_OAUTH_ACME_CLOUD_CLIENT_ID"] = "id";
    process.env["PROVIDER_OAUTH_ACME_CLOUD_CLIENT_SECRET"] = "secret";
  });

  it("leaves pasted credentials and fresh tokens alone", async () => {
    const doFetch = vi.fn();
    const pasted = await resolveOAuthCredentials({
      accountId: "a",
      organizationId: ORG,
      manifest,
      credentials: { apiToken: "p" },
      fetch: doFetch as unknown as typeof fetch,
    });
    expect(pasted).toEqual({ apiToken: "p" });
    const fresh = grantCredentials(Date.now() + 3_600_000);
    expect(
      await resolveOAuthCredentials({
        accountId: "a",
        organizationId: ORG,
        manifest,
        credentials: fresh,
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).toEqual(fresh);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("refreshes once for concurrent callers and persists the rotation", async () => {
    const stale = grantCredentials(Date.now() - 1000);
    const fake = fakeStore(stale);
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rt-1");
      expect(body.get("client_secret")).toBe("secret");
      return new Response(
        JSON.stringify({ access_token: "at-new", refresh_token: "rt-2", expires_in: 3600 }),
      );
    });
    const call = () =>
      resolveOAuthCredentials({
        accountId: "a",
        organizationId: ORG,
        manifest,
        credentials: stale,
        store: fake.store,
        fetch: doFetch as unknown as typeof fetch,
      });
    const results = await Promise.all([call(), call(), call()]);
    expect(doFetch).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r["apiToken"]).toBe("at-new");
    expect(fake.writes).toHaveLength(1);
    expect(fake.credentials["apiToken"]).toBe("at-new");
    expect(readOAuthGrantState(fake.credentials)?.refreshToken).toBe("rt-2");
    expect(fake.status).toBe("connected");
  });

  it("re-checks under the lock and skips a refresh another process already did", async () => {
    const stale = grantCredentials(Date.now() - 1000);
    // The stored row already holds a refreshed token (another replica won).
    const fake = fakeStore({
      ...grantCredentials(Date.now() + 3_600_000, "rt-2"),
      apiToken: "at-2",
    });
    const doFetch = vi.fn();
    const out = await resolveOAuthCredentials({
      accountId: "a",
      organizationId: ORG,
      manifest,
      credentials: stale,
      store: fake.store,
      fetch: doFetch as unknown as typeof fetch,
    });
    expect(doFetch).not.toHaveBeenCalled();
    expect(out["apiToken"]).toBe("at-2");
    expect(fake.writes).toHaveLength(0);
  });

  it("marks reconnect_required on invalid_grant", async () => {
    const stale = grantCredentials(Date.now() - 1000);
    const fake = fakeStore(stale);
    const doFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), {
          status: 400,
        }),
    );
    await expect(
      resolveOAuthCredentials({
        accountId: "a",
        organizationId: ORG,
        manifest,
        credentials: stale,
        store: fake.store,
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(OAuthReconnectRequiredError);
    expect(fake.status).toBe("reconnect_required");
    expect(fake.writes).toHaveLength(0);
  });

  it("does not mark reconnect on a transient failure", async () => {
    const stale = grantCredentials(Date.now() - 1000);
    const fake = fakeStore(stale);
    const doFetch = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(
      resolveOAuthCredentials({
        accountId: "a",
        organizationId: ORG,
        manifest,
        credentials: stale,
        store: fake.store,
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(fake.status).toBe("connected");
  });
});

describe("updateAccountCredentials", () => {
  it("merges under the lock without losing the stored grant", async () => {
    const fake = fakeStore(grantCredentials(Date.now() + 3_600_000, "rt-9"));
    await updateAccountCredentials("a", ORG, (c) => ({ ...c, spacesKey: "k" }), fake.store);
    expect(fake.credentials["spacesKey"]).toBe("k");
    expect(readOAuthGrantState(fake.credentials)?.refreshToken).toBe("rt-9");
  });
});
