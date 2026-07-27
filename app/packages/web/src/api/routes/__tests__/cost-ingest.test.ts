import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * The cost push endpoint. Row validation lives in server-core and is tested
 * there; what is tested here is the envelope, the scope it demands, and that a
 * rejected batch becomes a 400 carrying the validator's message rather than a
 * 500.
 */

const mockAuthenticate = vi.fn();
vi.mock("@/auth/org-request-auth", () => ({
  authenticateOrgRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));

class CostIngestError extends Error {}
const mockWrite = vi.fn();
vi.mock("@infrawrench/server-core/cost/external-costs", () => ({
  CostIngestError,
  MAX_EXTERNAL_COST_ROWS_PER_CALL: 5000,
  writeExternalCostRows: (...args: unknown[]) => mockWrite(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

const { costIngestRoutes } = await import("@/api/routes/cost-ingest");

const ROW = { date: "2026-07-01", currency: "USD", amount: 10 };

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/org/:orgId/costs", costIngestRoutes);
  return app;
}

async function post(body: unknown): Promise<Response> {
  return buildApp().request("/api/org/org-1/costs/rows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ userId: "user-1", organizationId: "org-1", via: "api-key" });
  mockWrite.mockResolvedValue({ written: 1 });
});

describe("POST /api/org/:orgId/costs/rows", () => {
  it("requires costs:write", async () => {
    await post({ source: "colo", rows: [ROW] });
    expect(mockAuthenticate).toHaveBeenCalledWith(expect.anything(), "org-1", "costs:write");
  });

  it("returns the auth failure verbatim", async () => {
    mockAuthenticate.mockResolvedValue(
      new Response(JSON.stringify({ error: "Missing required scope: costs:write" }), {
        status: 403,
      }),
    );
    const res = await post({ source: "colo", rows: [ROW] });
    expect(res.status).toBe(403);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("writes the batch and reports the row count", async () => {
    mockWrite.mockResolvedValue({ written: 2 });
    const res = await post({ source: "colo", rows: [ROW, ROW] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: 2 });
    expect(mockWrite).toHaveBeenCalledWith({
      organizationId: "org-1",
      source: "colo",
      rows: [ROW, ROW],
    });
  });

  it("audit-logs the push against the source", async () => {
    await post({ source: "colo", rows: [ROW] });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "costs.push", entityId: "colo", metadata: { rows: 1 } }),
    );
  });

  it("turns a rejected batch into a 400 carrying the reason", async () => {
    mockWrite.mockRejectedValue(new CostIngestError("costs/rows: row 3 has a non-finite amount."));
    const res = await post({ source: "colo", rows: [ROW] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/row 3/);
  });

  it("lets an unexpected failure surface as a 500, not as the caller's fault", async () => {
    mockWrite.mockRejectedValue(new Error("ClickHouse unreachable"));
    const res = await post({ source: "colo", rows: [ROW] });
    expect(res.status).toBe(500);
  });

  it.each([
    ["a missing source", { rows: [ROW] }],
    ["missing rows", { source: "colo" }],
    ["rows that aren't objects", { source: "colo", rows: ["nope"] }],
    ["more rows than one call allows", { source: "colo", rows: Array(5001).fill(ROW) }],
  ])("rejects %s", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("rejects a body that isn't JSON", async () => {
    const res = await buildApp().request("/api/org/org-1/costs/rows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
