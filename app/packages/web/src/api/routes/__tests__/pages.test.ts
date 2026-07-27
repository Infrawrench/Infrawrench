import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * The paging push endpoint. Auth is mocked because it is shared machinery with
 * its own tests (`chat/__tests__/auth.test.ts`); what is tested here is that
 * this route refuses a bad source, hands a well-formed spec to the pager, and
 * passes a suppressed page through as a 200 rather than an error.
 */

const mockAuthenticate = vi.fn();
vi.mock("@/auth/org-request-auth", () => ({
  authenticateOrgRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));

const mockPage = vi.fn();
const mockClear = vi.fn();
vi.mock("@infrawrench/server-core/paging/external-pages", () => ({
  pageFromExternal: (...args: unknown[]) => mockPage(...args),
  clearExternalPage: (...args: unknown[]) => mockClear(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

const { pageRoutes } = await import("@/api/routes/pages");

const DELIVERED = {
  delivered: true,
  suppressed: false,
  sms: 1,
  push: 0,
  slack: 0,
  msTeams: 0,
};

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/org/:orgId/pages", pageRoutes);
  return app;
}

async function post(body: unknown): Promise<Response> {
  return buildApp().request("/api/org/org-1/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ userId: "user-1", organizationId: "org-1", via: "api-key" });
  mockPage.mockResolvedValue(DELIVERED);
  mockClear.mockResolvedValue(true);
});

describe("POST /api/org/:orgId/pages", () => {
  it("requires pages:write", async () => {
    await post({ source: "checkout-api", message: "hi" });
    expect(mockAuthenticate).toHaveBeenCalledWith(expect.anything(), "org-1", "pages:write");
  });

  it("returns the auth failure verbatim", async () => {
    mockAuthenticate.mockResolvedValue(
      new Response(JSON.stringify({ error: "Missing required scope: pages:write" }), {
        status: 403,
      }),
    );
    const res = await post({ source: "checkout-api", message: "hi" });
    expect(res.status).toBe(403);
    expect(mockPage).not.toHaveBeenCalled();
  });

  it("pages with the parsed spec and reports the transports reached", async () => {
    const res = await post({
      source: "checkout-api",
      message: "5xx rate above 2%",
      title: "Checkout",
      key: "5xx",
      cooldownMinutes: 15,
      voice: true,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DELIVERED);
    expect(mockPage).toHaveBeenCalledWith(
      { organizationId: "org-1", source: "checkout-api" },
      {
        message: "5xx rate above 2%",
        title: "Checkout",
        key: "5xx",
        cooldownMinutes: 15,
        voice: true,
      },
    );
  });

  it("omits absent optional fields rather than passing them as undefined", async () => {
    await post({ source: "checkout-api", message: "plain" });
    expect(mockPage.mock.calls[0]?.[1]).toEqual({ message: "plain" });
  });

  it("passes a suppressed page through as a 200", async () => {
    mockPage.mockResolvedValue({
      delivered: false,
      suppressed: true,
      sms: 0,
      push: 0,
      slack: 0,
      msTeams: 0,
      retryAt: "2026-07-01T00:30:00.000Z",
    });
    const res = await post({ source: "checkout-api", message: "again" });
    expect(res.status).toBe(200);
    expect((await res.json()).retryAt).toBe("2026-07-01T00:30:00.000Z");
  });

  it.each([
    ["a missing message", { source: "checkout-api" }],
    ["an empty message", { source: "checkout-api", message: "" }],
    ["a cooldown beyond a day", { source: "checkout-api", message: "hi", cooldownMinutes: 1441 }],
    ["a negative cooldown", { source: "checkout-api", message: "hi", cooldownMinutes: -1 }],
  ])("rejects %s", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mockPage).not.toHaveBeenCalled();
  });

  it("rejects a source that isn't a slug", async () => {
    const res = await post({ source: "has a space", message: "hi" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/source must be/);
    expect(mockPage).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/org/:orgId/pages", () => {
  it("clears the named key", async () => {
    const res = await buildApp().request("/api/org/org-1/pages?source=checkout-api&key=5xx", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: true });
    expect(mockClear).toHaveBeenCalledWith("org-1", "checkout-api", "5xx");
  });

  it("defaults the key", async () => {
    await buildApp().request("/api/org/org-1/pages?source=checkout-api", { method: "DELETE" });
    expect(mockClear).toHaveBeenCalledWith("org-1", "checkout-api", "default");
  });

  it("reports a key that had no cooldown as not cleared, not as an error", async () => {
    mockClear.mockResolvedValue(false);
    const res = await buildApp().request("/api/org/org-1/pages?source=checkout-api", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: false });
  });

  it("rejects a missing source", async () => {
    const res = await buildApp().request("/api/org/org-1/pages", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(mockClear).not.toHaveBeenCalled();
  });
});
