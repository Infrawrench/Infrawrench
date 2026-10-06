import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";

/**
 * The paging-provider routes only parse, gate and audit; the work is in
 * server-core (mocked here, since it reaches the db client at import time).
 */
class PagingProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  act: vi.fn(),
  list: vi.fn(),
  webhook: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@infrawrench/server-core/paging/providers", () => ({
  PagingProviderError,
  actOnPagerIncident: (...a: unknown[]) => mocks.act(...a),
  handlePagingWebhook: (...a: unknown[]) => mocks.webhook(...a),
  listPagerIncidents: (...a: unknown[]) => mocks.list(...a),
  listPagingDestinations: vi.fn(async () => ({ accounts: [] })),
  listPagingEvents: vi.fn(async () => []),
  listPagingProviders: vi.fn(async () => []),
  previewProviderOnCall: vi.fn(),
  syncPagingIncidents: vi.fn(),
  updatePagingProviderSettings: (...a: unknown[]) => mocks.update(...a),
}));
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mocks.audit(...a) }));

const { pagingProviderRoutes, pagingIncidentRoutes, pagingWebhookRoutes } =
  await import("@/api/routes/paging-providers");

function orgApp(routes: Hono, permissions: string[]): Hono {
  const app = new Hono();
  const session: AuthSession = { userId: "user-1", email: "sam@example.com" };
  app.onError((err) => {
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    c.set("permissions", permissions);
    c.set("role", null);
    return next();
  });
  app.route("/", routes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /paging-providers/:accountId/settings", () => {
  it("requires org:settings:write", async () => {
    const res = await orgApp(pagingProviderRoutes, ["team:read"]).request("/acc-1/settings", {
      method: "PUT",
      body: JSON.stringify({ inboundEnabled: true }),
    });
    expect(res.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a body without inboundEnabled", async () => {
    const res = await orgApp(pagingProviderRoutes, ["org:settings:write"]).request(
      "/acc-1/settings",
      { method: "PUT", body: JSON.stringify({ webhookSecret: "x" }) },
    );
    expect(res.status).toBe(400);
  });

  it("passes the secret through and never audits it", async () => {
    mocks.update.mockResolvedValue({ account: { accountId: "acc-1" }, warning: null });
    const res = await orgApp(pagingProviderRoutes, ["org:settings:write"]).request(
      "/acc-1/settings",
      { method: "PUT", body: JSON.stringify({ inboundEnabled: true, webhookSecret: "whsec_abc" }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("org-1", "acc-1", {
      inboundEnabled: true,
      webhookSecret: "whsec_abc",
    });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("whsec_abc");
  });

  it("maps a provider error to its status", async () => {
    mocks.update.mockRejectedValue(new PagingProviderError("No paging provider account", 404));
    const res = await orgApp(pagingProviderRoutes, ["org:settings:write"]).request(
      "/acc-x/settings",
      { method: "PUT", body: JSON.stringify({ inboundEnabled: false }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("/paging-incidents", () => {
  it("lists open incidents by default with incidents:read", async () => {
    mocks.list.mockResolvedValue([]);
    const res = await orgApp(pagingIncidentRoutes, ["incidents:read"]).request("/");
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("org-1", { status: "open" });
  });

  it("acknowledges as the signed-in member", async () => {
    mocks.act.mockResolvedValue({ id: "i1", accountId: "a1", externalId: "P1", reference: "#7" });
    const res = await orgApp(pagingIncidentRoutes, ["incidents:write"]).request("/i1/acknowledge", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(mocks.act).toHaveBeenCalledWith("org-1", "i1", "acknowledge", "sam@example.com");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "paging_incident.acknowledge" }),
    );
  });

  it("turns a provider's 401 into a 400, not a session expiry", async () => {
    mocks.act.mockRejectedValue(Object.assign(new Error("bad key"), { status: 401 }));
    const res = await orgApp(pagingIncidentRoutes, ["incidents:write"]).request("/i1/resolve", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /paging-webhooks/:token", () => {
  const app = new Hono().route("/api", pagingWebhookRoutes);
  const token = "abcdefghijklmnopqrstuvwxyz012345";

  it("404s a malformed token without touching the store", async () => {
    const res = await app.request("/api/paging-webhooks/bad", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(mocks.webhook).not.toHaveBeenCalled();
  });

  it("passes the raw body and lowercased headers to the handler", async () => {
    mocks.webhook.mockResolvedValue(202);
    const res = await app.request(`/api/paging-webhooks/${token}`, {
      method: "POST",
      headers: { "X-PagerDuty-Signature": "v1=abc" },
      body: '{"event":{}}',
    });
    expect(res.status).toBe(202);
    const [t, headers, body] = mocks.webhook.mock.calls[0]!;
    expect(t).toBe(token);
    expect((headers as Record<string, string>)["x-pagerduty-signature"]).toBe("v1=abc");
    expect(body).toBe('{"event":{}}');
  });

  it("answers 401 for a bad signature", async () => {
    mocks.webhook.mockResolvedValue(401);
    const res = await app.request(`/api/paging-webhooks/${token}`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});
