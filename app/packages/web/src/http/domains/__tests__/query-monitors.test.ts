import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

/** The query monitor routes' wire: `resources:execute` to write or test, and the hand checks' sentences. */
class QueryMonitorInputError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

const mocks = vi.hoisted(() => ({ run: vi.fn(), create: vi.fn(), audit: vi.fn() }));

vi.mock("@infrawrench/server-core/query-monitors/store", () => ({
  QueryMonitorInputError,
  createQueryMonitor: (...a: unknown[]) => mocks.create(...a),
  deleteQueryMonitor: vi.fn(),
  getQueryMonitor: vi.fn(async () => null),
  listQueryMonitorTargets: vi.fn(async () => []),
  listQueryMonitors: vi.fn(async () => []),
  runMonitorQuery: (...a: unknown[]) => mocks.run(...a),
  updateQueryMonitor: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mocks.audit(...a) }));

const { queryMonitorsDomain } = await import("@/http/domains/query-monitors/index");
const app = (permissions?: string[]) =>
  buildTestApi(queryMonitorsDomain, {
    basePath: "/api/org/org-1/query-monitors",
    ...(permissions ? { permissions } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /query-monitors/test", () => {
  it("needs resources:execute, not resources:read", async () => {
    const res = await app(["resources:read"]).request("/test", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("needs an account and a query", async () => {
    const res = await app().request("/test", {
      method: "POST",
      body: JSON.stringify({ sql: "select 1" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "accountId and sql are required" });
  });

  it("applies the threshold to the preview", async () => {
    mocks.run.mockResolvedValue({ value: 5, error: null, durationMs: 3, rows: [{ n: 5 }] });
    const res = await app().request("/test", {
      method: "POST",
      body: JSON.stringify({ accountId: "a1", sql: "select 5", operator: "gt", threshold: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      value: 5,
      state: "breaching",
      error: null,
      durationMs: 3,
      rows: [{ n: 5 }],
    });
  });
});

describe("POST /query-monitors", () => {
  it("names a malformed field", async () => {
    const res = await app().request("/", { method: "POST", body: JSON.stringify({ mode: "avg" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "mode must be one of scalar, rowCount" });
  });
});

describe("GET /query-monitors/:monitorId", () => {
  it("404s with the route's sentence, and /targets is not a monitor id", async () => {
    const missing = await app().request("/m1");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No such monitor" });
    const targets = await app().request("/targets");
    expect(await targets.json()).toEqual({ accounts: [] });
  });
});
