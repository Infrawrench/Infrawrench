import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockAuthenticateWithCode = vi.fn();
vi.mock("@/auth/workos", () => ({
  clientId: "test_client_id",
  workos: {
    userManagement: {
      authenticateWithCode: (...a: unknown[]) => mockAuthenticateWithCode(...a),
    },
  },
}));

const { callbackRoutes } = await import("@/api/routes/callback");

function buildApp() {
  const app = new Hono();
  app.route("/", callbackRoutes);
  return app;
}

describe("OAuth callback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["WORKOS_COOKIE_PASSWORD"] = "a".repeat(40);
  });

  it("400s when the code is missing", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Missing code/);
  });

  it("renders the provider error on an error redirect, HTML-escaped", async () => {
    const res = await buildApp().request(
      "/?error=user_not_found&error_description=%3Cscript%3Ex%3C%2Fscript%3E",
    );
    expect(res.status).toBe(400);
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
    expect(res.headers.get("set-cookie") ?? "").toContain("iw_oauth_retry=1");
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
    const body = await res.text();
    expect(body).toMatch(/Sign-in could not be completed/);
    expect(body).toContain('href="/api/auth/sign-in"');
    expect(mockAuthenticateWithCode).not.toHaveBeenCalled();
    // The marker is cleared so the next attempt gets its retry back.
    expect(res.headers.get("set-cookie") ?? "").toContain("iw_oauth_retry=;");
  });

  it("exchanges the code, sets the session cookie, and redirects", async () => {
    mockAuthenticateWithCode.mockResolvedValue({ sealedSession: "sealed-blob" });
    const res = await buildApp().request("/?code=abc&state=nonce123", {
      headers: { cookie: "iw_oauth_state=nonce123" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("wos-session=sealed-blob");
    // The single-use state cookie should be cleared.
    expect(setCookie).toContain("iw_oauth_state=");
    // …as should the retry marker, so a later failure gets a fresh restart.
    expect(setCookie).toContain("iw_oauth_retry=");
  });

  it("500s when WorkOS returns no sealed session", async () => {
    mockAuthenticateWithCode.mockResolvedValue({ sealedSession: null });
    const res = await buildApp().request("/?code=abc&state=nonce123", {
      headers: { cookie: "iw_oauth_state=nonce123" },
    });
    expect(res.status).toBe(500);
  });
});
