import type { webcrypto } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url, utf8 } from "../encoding";
import { type Jwk, clearKeySetCache, remoteKeySet, verifyJwt } from "../jwt";
import { authenticateSession } from "../session";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_INSECURE,
  type SessionData,
  clearSessionCookie,
  parseCookies,
  seal,
  sealSession,
  setSessionCookie,
  unseal,
  unsealSession,
} from "../session-cookie";
import {
  handleCallback,
  handleSignIn,
  handleSignOut,
  isSameOrigin,
  safeReturnTo,
} from "../sign-in";
import {
  type WorkosConfig,
  type WorkosUser,
  authorizationUrl,
  jwksUrl,
  logoutUrl,
  workosConfig,
} from "../workos";

const PASSWORD = "p".repeat(40);
const NOW = 1_800_000_000;

const config: WorkosConfig = {
  baseUrl: "https://auth-api.example.test",
  clientId: "client_123",
  apiKey: "sk_test_placeholder",
  redirectUri: "https://git.example.test/auth/callback",
};

const env = {
  WORKOS_API_KEY: config.apiKey,
  WORKOS_CLIENT_ID: config.clientId,
  WORKOS_COOKIE_PASSWORD: PASSWORD,
  SITE_ORIGIN: "https://git.example.test",
};

let privateKey: webcrypto.CryptoKey;
let jwk: Jwk;

const signJwt = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
  const head = toBase64Url(
    utf8(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1", ...header })),
  );
  const body = toBase64Url(utf8(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    utf8(`${head}.${body}`),
  );
  return `${head}.${body}.${toBase64Url(new Uint8Array(signature))}`;
};

const keys = async (kid: string | undefined) => (kid === "k1" ? jwk : null);

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk = { kty: "RSA", kid: "k1", n: exported.n!, e: exported.e! };
});

beforeEach(() => clearKeySetCache());

const user: WorkosUser = {
  id: "user_1",
  email: "astrid@example.test",
  firstName: "Astrid",
  lastName: null,
  profilePictureUrl: null,
};

const workosAnswer = (accessToken: string, refreshToken: string) =>
  new Response(
    JSON.stringify({
      user: { id: user.id, email: user.email, first_name: "Astrid", last_name: null },
      access_token: accessToken,
      refresh_token: refreshToken,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("sealing", () => {
  it("round-trips a value", async () => {
    const sealed = await seal({ a: 1 }, PASSWORD);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(await unseal(sealed, PASSWORD)).toEqual({ a: 1 });
  });

  it("seals the same value differently each time", async () => {
    expect(await seal({ a: 1 }, PASSWORD)).not.toBe(await seal({ a: 1 }, PASSWORD));
  });

  it("opens nothing another password sealed, and nothing altered", async () => {
    const sealed = await seal({ a: 1 }, PASSWORD);
    expect(await unseal(sealed, "q".repeat(40))).toBe(null);
    const parts = sealed.split(".");
    const flipped = parts[3]!.startsWith("A") ? `B${parts[3]!.slice(1)}` : `A${parts[3]!.slice(1)}`;
    expect(await unseal([parts[0], parts[1], parts[2], flipped].join("."), PASSWORD)).toBe(null);
    // One cookie's salt with another's body.
    const other = (await seal({ a: 2 }, PASSWORD)).split(".");
    expect(await unseal([parts[0], other[1], parts[2], parts[3]].join("."), PASSWORD)).toBe(null);
    for (const junk of ["", "v1", "v2.a.b.c", "v1.a.b", "not a cookie"]) {
      expect(await unseal(junk, PASSWORD)).toBe(null);
    }
  });

  it("refuses a short password outright", async () => {
    await expect(seal({ a: 1 }, "short")).rejects.toThrow(/WORKOS_COOKIE_PASSWORD/);
    await expect(unseal(await seal({ a: 1 }, PASSWORD), "short")).rejects.toThrow(
      /WORKOS_COOKIE_PASSWORD/,
    );
  });

  it("only reads back a whole session", async () => {
    const session: SessionData = {
      userId: "user_1",
      email: "a@example.test",
      accessToken: "a",
      refreshToken: "r",
      sessionId: null,
    };
    expect(await unsealSession(await sealSession(session, PASSWORD), PASSWORD)).toEqual(session);
    expect(await unsealSession(await seal({ userId: "user_1" }, PASSWORD), PASSWORD)).toBe(null);
  });
});

describe("cookies", () => {
  it("is host-only, HttpOnly and Lax, with the __Host- prefix over HTTPS", () => {
    const line = setSessionCookie("value", true);
    expect(line.startsWith(`${SESSION_COOKIE}=value;`)).toBe(true);
    expect(line).toContain("Path=/");
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Secure");
    expect(line).not.toMatch(/Domain=/i);
  });

  it("drops the prefix and Secure over plain HTTP", () => {
    const line = setSessionCookie("value", false);
    expect(line.startsWith(`${SESSION_COOKIE_INSECURE}=value;`)).toBe(true);
    expect(line).not.toContain("Secure");
  });

  it("clears with Max-Age=0", () => {
    expect(clearSessionCookie(true)).toContain("Max-Age=0");
  });

  it("parses a Cookie header", () => {
    const cookies = parseCookies("a=1; __Host-iwg-session=v1.x.y.z; a=2; b=c=d");
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("__Host-iwg-session")).toBe("v1.x.y.z");
    expect(cookies.get("b")).toBe("c=d");
    expect(parseCookies(null).size).toBe(0);
  });
});

describe("verifyJwt", () => {
  it("accepts a token the key signed", async () => {
    const token = await signJwt({ sub: "user_1", sid: "session_1", exp: NOW + 300 });
    const result = await verifyJwt(token, keys, NOW);
    expect(result).toMatchObject({ ok: true, claims: { sub: "user_1", sid: "session_1" } });
  });

  it("refuses an expired token, with a little leeway", async () => {
    const token = await signJwt({ sub: "user_1", exp: NOW });
    expect(await verifyJwt(token, keys, NOW + 29)).toMatchObject({ ok: true });
    expect(await verifyJwt(token, keys, NOW + 31)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyJwt(await signJwt({ sub: "user_1" }), keys, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses altered claims", async () => {
    const token = await signJwt({ sub: "user_1", exp: NOW + 300 });
    const [head, , signature] = token.split(".");
    const forged = toBase64Url(utf8(JSON.stringify({ sub: "user_2", exp: NOW + 300 })));
    expect(await verifyJwt(`${head}.${forged}.${signature}`, keys, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("refuses any algorithm but RS256, before looking for a key", async () => {
    const asked = vi.fn(keys);
    const none = `${toBase64Url(utf8(JSON.stringify({ alg: "none" })))}.${toBase64Url(
      utf8(JSON.stringify({ sub: "user_1", exp: NOW + 300 })),
    )}.`;
    expect(await verifyJwt(none, asked, NOW)).toMatchObject({ ok: false });
    const hs = await signJwt({ sub: "user_1", exp: NOW + 300 }, { alg: "HS256" });
    expect(await verifyJwt(hs, asked, NOW)).toEqual({ ok: false, reason: "unsupported" });
    expect(asked).not.toHaveBeenCalled();
  });

  it("refuses a key it does not have, and junk", async () => {
    const token = await signJwt({ sub: "user_1", exp: NOW + 300 }, { kid: "other" });
    expect(await verifyJwt(token, keys, NOW)).toEqual({ ok: false, reason: "unknown_key" });
    for (const junk of ["", "a.b", "a.b.c", "....", "x".repeat(9000)]) {
      expect((await verifyJwt(junk, keys, NOW)).ok).toBe(false);
    }
  });

  it("fetches a key set once and refetches for an unknown kid only after a pause", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] })));
    const remote = remoteKeySet("https://auth-api.example.test/sso/jwks/client_123", fetcher);
    expect(await remote("k1")).toEqual(jwk);
    expect(await remote("k1")).toEqual(jwk);
    expect(await remote("nope")).toBe(null);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("answers null when the key set cannot be fetched", async () => {
    const remote = remoteKeySet("https://auth-api.example.test/jwks", async () => {
      throw new Error("offline");
    });
    expect(await remote("k1")).toBe(null);
  });
});

describe("WorkOS URLs", () => {
  it("builds the AuthKit authorization URL", () => {
    const url = new URL(authorizationUrl(config, "state-value"));
    expect(url.origin + url.pathname).toBe(
      "https://auth-api.example.test/user_management/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: "authkit",
      client_id: "client_123",
      redirect_uri: "https://git.example.test/auth/callback",
      response_type: "code",
      state: "state-value",
    });
  });

  it("builds the JWKS and logout URLs", () => {
    expect(jwksUrl(config)).toBe("https://auth-api.example.test/sso/jwks/client_123");
    expect(logoutUrl(config, "session_1", "https://git.example.test/")).toBe(
      "https://auth-api.example.test/user_management/sessions/logout?session_id=session_1&return_to=https%3A%2F%2Fgit.example.test%2F",
    );
  });

  it("reads its configuration from the environment", () => {
    expect(workosConfig(env)).toEqual({
      baseUrl: "https://api.workos.com",
      clientId: "client_123",
      apiKey: config.apiKey,
      redirectUri: "https://git.example.test/auth/callback",
    });
    expect(workosConfig({ ...env, WORKOS_API_HOSTNAME: "auth-api.infrawrench.com" }).baseUrl).toBe(
      "https://auth-api.infrawrench.com",
    );
    expect(workosConfig({ ...env, WORKOS_API_HOSTNAME: "localhost:4100" }).baseUrl).toBe(
      "http://localhost:4100",
    );
    expect(() => workosConfig({ ...env, WORKOS_API_KEY: "" })).toThrow(/WORKOS_API_KEY/);
  });
});

describe("authenticateSession", () => {
  const sealedWith = async (accessToken: string, overrides: Partial<SessionData> = {}) =>
    sealSession(
      {
        userId: "user_1",
        email: "astrid@example.test",
        accessToken,
        refreshToken: "refresh_1",
        sessionId: "session_1",
        ...overrides,
      },
      PASSWORD,
    );

  const deps = (fetcher: typeof fetch = async () => new Response("unused", { status: 500 })) => ({
    config,
    password: PASSWORD,
    keys,
    provision: vi.fn(async () => {}),
    fetcher,
    now: NOW,
  });

  it("accepts a live access token without calling WorkOS", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const d = deps(fetcher);
    const sealed = await sealedWith(await signJwt({ sub: "user_1", exp: NOW + 300 }));
    const outcome = await authenticateSession(sealed, d);
    expect(outcome).toMatchObject({
      kind: "valid",
      refreshed: null,
      session: { userId: "user_1" },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(d.provision).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token, provisions, and hands back a new sealed session", async () => {
    const fresh = await signJwt({ sub: "user_1", sid: "session_2", exp: NOW + 300 });
    const fetcher = vi.fn<typeof fetch>(async () => workosAnswer(fresh, "refresh_2"));
    const d = deps(fetcher);
    const sealed = await sealedWith(await signJwt({ sub: "user_1", exp: NOW - 600 }));
    const outcome = await authenticateSession(sealed, d);
    if (outcome.kind !== "valid" || outcome.refreshed === null)
      throw new Error("expected a refresh");
    expect(await unsealSession(outcome.refreshed, PASSWORD)).toEqual({
      userId: "user_1",
      email: "astrid@example.test",
      accessToken: fresh,
      refreshToken: "refresh_2",
      sessionId: "session_2",
    });
    expect(d.provision).toHaveBeenCalledWith(expect.objectContaining({ id: "user_1" }));

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://auth-api.example.test/user_management/authenticate");
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh_1",
      client_id: "client_123",
      client_secret: config.apiKey,
    });
  });

  it("treats a refused refresh as signed out, without clearing the cookie", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const sealed = await sealedWith(await signJwt({ sub: "user_1", exp: NOW - 600 }));
    expect(await authenticateSession(sealed, deps(fetcher))).toEqual({ kind: "stale" });
  });

  it("does not sign anyone out because WorkOS is down", async () => {
    const sealed = await sealedWith(await signJwt({ sub: "user_1", exp: NOW - 600 }));
    await expect(
      authenticateSession(
        sealed,
        deps(async () => new Response("oops", { status: 503 })),
      ),
    ).rejects.toThrow(/WorkOS refresh failed \(503/);
  });

  it("refuses a refresh that comes back as somebody else", async () => {
    const other = await signJwt({ sub: "user_2", exp: NOW + 300 });
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          user: { id: "user_2", email: "other@example.test" },
          access_token: other,
          refresh_token: "r",
        }),
      );
    const sealed = await sealedWith(await signJwt({ sub: "user_1", exp: NOW - 600 }));
    expect(await authenticateSession(sealed, deps(fetcher))).toEqual({ kind: "stale" });
  });

  it("calls anything it did not seal garbage", async () => {
    expect(await authenticateSession("not-a-cookie", deps())).toEqual({ kind: "garbage" });
    const mismatched = await sealedWith(await signJwt({ sub: "user_2", exp: NOW + 300 }));
    expect(await authenticateSession(mismatched, deps())).toEqual({ kind: "garbage" });
  });
});

describe("sign-in routes", () => {
  const request = (url: string, headers: Record<string, string> = {}, method = "GET") => ({
    url,
    method,
    headers: new Headers(headers),
  });

  it("only returns to paths on this site", () => {
    expect(safeReturnTo("/acme/infra?tab=code")).toBe("/acme/infra?tab=code");
    for (const bad of [
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "acme",
      "/auth/sign-in",
      "/auth",
      "/a\nb",
    ]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });

  it("redirects to AuthKit with a sealed state and a nonce cookie", async () => {
    const response = await handleSignIn(
      request("https://git.example.test/auth/sign-in?returnTo=/acme/infra"),
      env,
      { config },
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/user_management/authorize");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie.startsWith("__Host-iwg-auth-state=")).toBe(true);
    const nonce = cookie.split(";")[0]!.split("=")[1];
    expect(await unseal(location.searchParams.get("state")!, PASSWORD)).toEqual({
      nonce,
      returnTo: "/acme/infra",
    });
  });

  const start = async (returnTo = "/acme/infra") => {
    const response = await handleSignIn(
      request(`https://git.example.test/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`),
      env,
      { config },
    );
    return {
      state: new URL(response.headers.get("location")!).searchParams.get("state")!,
      cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    };
  };

  it("finishes a sign-in: exchanges the code, provisions, sets the session, returns", async () => {
    const { state, cookie } = await start();
    const accessToken = await signJwt({ sub: "user_1", sid: "session_1", exp: NOW + 300 });
    const fetcher = vi.fn<typeof fetch>(async () => workosAnswer(accessToken, "refresh_1"));
    const provision = vi.fn(async () => {});
    const response = await handleCallback(
      request(
        `https://git.example.test/auth/callback?code=code_1&state=${encodeURIComponent(state)}`,
        { cookie, "user-agent": "test-agent" },
      ),
      env,
      { config, fetcher, provision },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/acme/infra");
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ id: "user_1" }));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      grant_type: "authorization_code",
      code: "code_1",
      client_id: "client_123",
      client_secret: config.apiKey,
      user_agent: "test-agent",
    });

    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookies.find((line) => line.startsWith(`${SESSION_COOKIE}=`))!;
    const sealed = sessionCookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
    expect(await unsealSession(sealed, PASSWORD)).toMatchObject({
      userId: "user_1",
      sessionId: "session_1",
      refreshToken: "refresh_1",
    });
    expect(cookies.some((line) => line.startsWith("__Host-iwg-auth-state=;"))).toBe(true);
  });

  it("refuses a callback whose state is not this browser's", async () => {
    const { state } = await start();
    const other = await start();
    const fetcher = vi.fn<typeof fetch>();
    const provision = vi.fn(async () => {});
    const url = `https://git.example.test/auth/callback?code=code_1&state=${encodeURIComponent(state)}`;
    for (const headers of [{}, { cookie: other.cookie }, { cookie: "__Host-iwg-auth-state=x" }]) {
      const response = await handleCallback(request(url, headers), env, {
        config,
        fetcher,
        provision,
      });
      expect(response.headers.get("location")).toBe("/?auth_error=state");
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("lands on the home page when WorkOS reports an error or refuses the code", async () => {
    const denied = await handleCallback(
      request("https://git.example.test/auth/callback?error=access_denied"),
      env,
      { config, provision: async () => {} },
    );
    expect(denied.headers.get("location")).toBe("/?auth_error=denied");

    const { state, cookie } = await start();
    const refused = await handleCallback(
      request(
        `https://git.example.test/auth/callback?code=bad&state=${encodeURIComponent(state)}`,
        {
          cookie,
        },
      ),
      env,
      {
        config,
        provision: async () => {},
        fetcher: async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      },
    );
    expect(refused.headers.get("location")).toBe("/?auth_error=exchange");
    expect(refused.headers.getSetCookie().some((line) => line.startsWith(SESSION_COOKIE))).toBe(
      false,
    );
  });

  it("signs out: clears the cookie and goes through WorkOS's logout", async () => {
    const sealed = await sealSession(
      {
        userId: "user_1",
        email: "a@example.test",
        accessToken: "a",
        refreshToken: "r",
        sessionId: "session_1",
      },
      PASSWORD,
    );
    const response = await handleSignOut(
      request(
        "https://git.example.test/auth/sign-out",
        { cookie: `${SESSION_COOKIE}=${sealed}`, origin: "https://git.example.test" },
        "POST",
      ),
      env,
      { config },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(
      "/user_management/sessions/logout?session_id=session_1",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("signs out of nothing gracefully, only by POST, only from this site", async () => {
    const none = await handleSignOut(
      request("https://git.example.test/auth/sign-out", {}, "POST"),
      env,
      { config },
    );
    expect(none.headers.get("location")).toBe("/");
    const get = await handleSignOut(request("https://git.example.test/auth/sign-out"), env, {
      config,
    });
    expect(get.status).toBe(405);
    const cross = await handleSignOut(
      request("https://git.example.test/auth/sign-out", { origin: "https://evil.example" }, "POST"),
      env,
      { config },
    );
    expect(cross.status).toBe(403);
  });

  it("checks the origin of writes only", () => {
    const from = (origin: string | null, method: string) =>
      isSameOrigin(
        request("https://git.example.test/api/repos", origin ? { origin } : {}, method),
        env,
      );
    expect(from("https://evil.example", "GET")).toBe(true);
    expect(from("https://evil.example", "POST")).toBe(false);
    expect(from("https://app.example.test", "DELETE")).toBe(false);
    expect(from("https://git.example.test", "POST")).toBe(true);
    expect(from(null, "POST")).toBe(true);
  });
});
