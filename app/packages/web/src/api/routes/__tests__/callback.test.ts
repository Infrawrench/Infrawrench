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

  it("400s when the OAuth state cookie does not match the query", async () => {
    const res = await buildApp().request("/?code=abc&state=mismatch", {
      headers: { cookie: "iw_oauth_state=expected" },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Invalid OAuth state/);
    expect(mockAuthenticateWithCode).not.toHaveBeenCalled();
  });

  it("400s when there is no state cookie at all", async () => {
    const res = await buildApp().request("/?code=abc&state=foo");
    expect(res.status).toBe(400);
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
  });

  it("500s when WorkOS returns no sealed session", async () => {
    mockAuthenticateWithCode.mockResolvedValue({ sealedSession: null });
    const res = await buildApp().request("/?code=abc&state=nonce123", {
      headers: { cookie: "iw_oauth_state=nonce123" },
    });
    expect(res.status).toBe(500);
  });
});
