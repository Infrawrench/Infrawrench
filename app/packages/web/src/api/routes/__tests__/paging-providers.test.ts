import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * The inbound paging webhook, the one paging route still on Hono. The work is
 * in server-core (mocked here, since it reaches the db client at import time).
 * The org-tree routes' tests are in `http/domains/__tests__/paging-providers.test.ts`.
 */
const mocks = vi.hoisted(() => ({ webhook: vi.fn() }));

vi.mock("@infrawrench/server-core/paging/providers", () => ({
  handlePagingWebhook: (...a: unknown[]) => mocks.webhook(...a),
}));

const { pagingWebhookRoutes } = await import("@/api/routes/paging-providers");

beforeEach(() => {
  vi.clearAllMocks();
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
