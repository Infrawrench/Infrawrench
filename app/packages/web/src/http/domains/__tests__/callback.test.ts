import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateCookie } from "hono/cookie";

const mockAuthenticateWithCode = vi.fn();
vi.mock("@/auth/workos", () => ({
  clientId: "test_client_id",
  workos: {
    userManagement: {
      authenticateWithCode: (...a: unknown[]) => mockAuthenticateWithCode(...a),
    },
  },
}));

const { callbackDomain } = await import("@/http/domains/callback/index");
const { buildTestApi } = await import("@/http/testing");
const { OAUTH_COOKIE_MAX_AGE } = await import("@/api/oauth-state");

function buildApp() {
  return buildTestApi(callbackDomain, { basePath: "/callback" });
}

/** A deletion as Hono's `deleteCookie(c, name, { path: "/" })` wrote it. */
const deleted = (name: string) => generateCookie(name, "", { path: "/", maxAge: 0 });

describe("OAuth callback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["WORKOS_COOKIE_PASSWORD"] = "a".repeat(40);
  });

  it("400s when the code is missing", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await res.text()).toBe("Missing code parameter");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("renders the provider error on an error redirect, HTML-escaped", async () => {
    const res = await buildApp().request(
      "/?error=user_not_found&error_description=%3Cscript%3Ex%3C%2Fscript%3E",
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    const body = await res.text();
    expect(body).toContain("user_not_found");
    expect(body).not.toContain("<script>");
    // The unverified flow never exchanges anything.
    expect(mockAuthenticateWithCode).not.toHaveBeenCalled();
  });

  it("restarts sign-in when the OAuth state cookie does not match the query", async () => {
    const res = await buildApp().request("/?code=abc&state=mismatch", {
      headers: { cookie: "iw_oauth_state=expected" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/auth/sign-in");
    expect(res.headers.getSetCookie()).toEqual([
      deleted("iw_oauth_state"),
      generateCookie("iw_oauth_retry", "1", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: OAUTH_COOKIE_MAX_AGE,
      }),
    ]);
    // The code is never exchanged on a failed state check.
    expect(mockAuthenticateWithCode).not.toHaveBeenCalled();
  });

  it("restarts sign-in when there is no state cookie at all", async () => {
    const res = await buildApp().request("/?code=abc&state=foo", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/auth/sign-in");
  });

  it("carries the pending destination across the restart", async () => {
    const res = await buildApp().request("/?code=abc&state=foo", {
      headers: { cookie: "iw_return_to=/org/abc/settings" },
      redirect: "manual",
    });
    expect(res.headers.get("location")).toBe("/api/auth/sign-in?return_to=%2Forg%2Fabc%2Fsettings");
  });

  it("drops an unsafe pending destination rather than restarting with it", async () => {
    const res = await buildApp().request("/?code=abc&state=foo", {
      headers: { cookie: "iw_return_to=https://evil.example" },
      redirect: "manual",
    });
    expect(res.headers.get("location")).toBe("/api/auth/sign-in");
  });

  it("shows a recoverable error page instead of looping on a second failure", async () => {
    const res = await buildApp().request("/?code=abc&state=foo", {
      headers: { cookie: "iw_oauth_retry=1" },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    const body = await res.text();
    expect(body).toMatch(/Sign-in could not be completed/);
    expect(body).toContain('href="/api/auth/sign-in"');
    expect(mockAuthenticateWithCode).not.toHaveBeenCalled();
    // The marker is cleared so the next attempt gets its retry back.
    expect(res.headers.getSetCookie()).toEqual([
      deleted("iw_oauth_state"),
      deleted("iw_oauth_retry"),
      deleted("iw_return_to"),
    ]);
  });

  it("exchanges the code, sets the session cookie, and redirects", async () => {
    mockAuthenticateWithCode.mockResolvedValue({ sealedSession: "sealed-blob" });
    const res = await buildApp().request("/?code=abc&state=nonce123", {
      headers: { cookie: "iw_oauth_state=nonce123" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(mockAuthenticateWithCode).toHaveBeenCalledWith({
      code: "abc",
      clientId: "test_client_id",
      session: { sealSession: true, cookiePassword: "a".repeat(40) },
    });
    // The single-use state cookie and the retry marker are cleared, so a later
    // failure gets a fresh restart.
    expect(res.headers.getSetCookie()).toEqual([
      deleted("iw_oauth_state"),
      generateCookie("wos-session", "sealed-blob", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 400,
      }),
      deleted("iw_oauth_retry"),
      deleted("iw_return_to"),
    ]);
  });

  it("lands on the pending destination after a successful exchange", async () => {
    mockAuthenticateWithCode.mockResolvedValue({ sealedSession: "sealed-blob" });
    const res = await buildApp().request("/?code=abc&state=nonce123", {
      headers: { cookie: "iw_oauth_state=nonce123; iw_return_to=%2Forg%2Fabc%2Fsettings" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/org/abc/settings");
  });

  it("500s when WorkOS returns no sealed session", async () => {
    mockAuthenticateWithCode.mockResolvedValue({ sealedSession: null });
    const res = await buildApp().request("/?code=abc&state=nonce123", {
      headers: { cookie: "iw_oauth_state=nonce123" },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Failed to seal session");
    expect(res.headers.getSetCookie()).toEqual([deleted("iw_oauth_state")]);
  });

  it("answers a refused code as the API's 500, still clearing the state cookie", async () => {
    mockAuthenticateWithCode.mockRejectedValue(new Error("invalid_grant"));
    const res = await buildApp().request("/?code=abc&state=nonce123", {
      headers: { cookie: "iw_oauth_state=nonce123" },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(res.headers.getSetCookie()).toEqual([deleted("iw_oauth_state")]);
  });
});
