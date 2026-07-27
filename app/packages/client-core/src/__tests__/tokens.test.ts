import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenManager, jwtExpMillis, type TokenStorage } from "../tokens";

function memoryStorage(): TokenStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

function makeJwt(expSecondsFromNow: number): string {
  const payload = { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow };
  const b64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${b64}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("jwtExpMillis", () => {
  it("parses exp from a JWT payload", () => {
    const jwt = makeJwt(3600);
    const exp = jwtExpMillis(jwt);
    expect(exp).toBeGreaterThan(Date.now() + 3500_000);
    expect(exp).toBeLessThan(Date.now() + 3700_000);
  });

  it("falls back to +5min for malformed tokens", () => {
    const now = 1_000_000;
    expect(jwtExpMillis("garbage", now)).toBe(now + 300_000);
    expect(jwtExpMillis("a.!!!.c", now)).toBe(now + 300_000);
  });
});

describe("TokenManager", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let onAuthError: ReturnType<typeof vi.fn<(code: string, message: string) => void>>;
  let tm: TokenManager;

  beforeEach(() => {
    storage = memoryStorage();
    fetchMock = vi.fn();
    onAuthError = vi.fn<(code: string, message: string) => void>();
    tm = new TokenManager({
      storage,
      clientId: "client_x",
      workosApiUrl: "https://api.workos.test",
      fetch: fetchMock as unknown as typeof fetch,
      onAuthError,
    });
  });

  it("exchanges an authorization code and persists tokens", async () => {
    const access = makeJwt(3600);
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: access,
        refresh_token: "rt1",
        user: { email: "a@b.c" },
        organization_id: "org1",
      }),
    );
    const out = await tm.exchangeAuthorizationCode("code1", "verifier1");
    expect(out).toEqual({ email: "a@b.c", organizationId: "org1" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).toMatchObject({
      grant_type: "authorization_code",
      code: "code1",
      code_verifier: "verifier1",
      client_id: "client_x",
    });
    expect(await tm.getAccessToken()).toBe(access);
    expect(storage.data.get("cloud_refresh_token")).toBe("rt1");
  });

  it("returns the stored token without refresh when far from expiry", async () => {
    const access = makeJwt(3600);
    storage.data.set("cloud_access_token", access);
    storage.data.set("cloud_refresh_token", "rt1");
    storage.data.set("cloud_token_expires_at", String(Date.now() + 3600_000));
    expect(await tm.getAccessToken()).toBe(access);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes when the token is near expiry", async () => {
    const newAccess = makeJwt(3600);
    storage.data.set("cloud_access_token", "old");
    storage.data.set("cloud_refresh_token", "rt1");
    storage.data.set("cloud_token_expires_at", String(Date.now() + 10_000)); // <60s
    fetchMock.mockResolvedValue(jsonResponse({ access_token: newAccess, refresh_token: "rt2" }));
    expect(await tm.getAccessToken()).toBe(newAccess);
    expect(storage.data.get("cloud_refresh_token")).toBe("rt2");
  });

  it("single-flights concurrent refreshes", async () => {
    const newAccess = makeJwt(3600);
    storage.data.set("cloud_access_token", "old");
    storage.data.set("cloud_refresh_token", "rt1");
    storage.data.set("cloud_token_expires_at", "0");
    let resolveFetch!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolveFetch = r)));
    const p1 = tm.getAccessToken();
    const p2 = tm.getAccessToken();
    // Both callers await the same in-flight refresh.
    resolveFetch(jsonResponse({ access_token: newAccess, refresh_token: "rt2" }));
    expect(await p1).toBe(newAccess);
    expect(await p2).toBe(newAccess);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears tokens and notifies on invalid_grant", async () => {
    storage.data.set("cloud_access_token", "old");
    storage.data.set("cloud_refresh_token", "dead");
    storage.data.set("cloud_token_expires_at", "0");
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
    expect(await tm.getAccessToken()).toBeNull();
    expect(onAuthError).toHaveBeenCalledWith("refresh-revoked", expect.any(String));
    expect(storage.data.has("cloud_refresh_token")).toBe(false);
  });

  it("keeps tokens on transient refresh failures", async () => {
    storage.data.set("cloud_access_token", "old");
    storage.data.set("cloud_refresh_token", "rt1");
    storage.data.set("cloud_token_expires_at", "0");
    fetchMock.mockResolvedValue(jsonResponse({ error: "server_error" }, 500));
    expect(await tm.getAccessToken()).toBeNull();
    expect(onAuthError).not.toHaveBeenCalled();
    expect(storage.data.get("cloud_refresh_token")).toBe("rt1");
  });

  it("keeps tokens on network errors", async () => {
    storage.data.set("cloud_access_token", "old");
    storage.data.set("cloud_refresh_token", "rt1");
    storage.data.set("cloud_token_expires_at", "0");
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await tm.getAccessToken()).toBeNull();
    expect(storage.data.get("cloud_refresh_token")).toBe("rt1");
  });

  it("returns null when signed out", async () => {
    expect(await tm.getAccessToken()).toBeNull();
    expect(await tm.isAuthenticated()).toBe(false);
  });

  it("gives up on a refresh that never answers", async () => {
    // A host that accepts the connection and then goes quiet. Without a
    // timeout this promise never settles, and every caller waiting on
    // isAuthenticated() — including the mobile launch screen — waits forever.
    storage.data.set("cloud_access_token", "old");
    storage.data.set("cloud_refresh_token", "rt1");
    storage.data.set("cloud_token_expires_at", "0");

    const timed = new TokenManager({
      storage,
      clientId: "client_x",
      workosApiUrl: "https://api.workos.test",
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
      requestTimeoutMs: 20,
    });

    expect(await timed.isAuthenticated()).toBe(false);
    // Transient as far as we know — the refresh token survives for a retry.
    expect(storage.data.get("cloud_refresh_token")).toBe("rt1");
  });
});
