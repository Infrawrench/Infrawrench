import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The store and the metric readers reach Postgres and ClickHouse; these tests
// are about the transport: the hand-picked body, statuses, the store's
// refusals and the routes' own sentences.
class FakeProbeInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockGet = vi.fn();
const mockList = vi.fn();
vi.mock("@infrawrench/server-core/probes/store", () => ({
  ProbeInputError: FakeProbeInputError,
  createProbeRecord: (...a: unknown[]) => mockCreate(...a),
  updateProbeRecord: (...a: unknown[]) => mockUpdate(...a),
  deleteProbeRecord: (...a: unknown[]) => mockDelete(...a),
  getProbeRecord: (...a: unknown[]) => mockGet(...a),
  listProbeRecords: (...a: unknown[]) => mockList(...a),
}));
const mockRange = vi.fn();
const mockAverages = vi.fn();
vi.mock("@infrawrench/server-core/clickhouse/readers", () => ({
  getMetricRange: (...a: unknown[]) => mockRange(...a),
  getMetricSeriesAverageBatch: (...a: unknown[]) => mockAverages(...a),
}));
vi.mock("@/db/client", () => ({ db: {} }));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { probesDomain } = await import("@/http/domains/probes/index");
const basePath = "/api/org/org-1/probes";
const app = (permissions?: string[]) =>
  buildTestApi(probesDomain, { basePath, ...(permissions ? { permissions } : {}) });

const row = {
  id: "p1",
  name: "API",
  url: "https://api.example.com/health",
  method: "GET",
  intervalSeconds: 60,
  timeoutMs: 10000,
  failureThreshold: 3,
  enabled: true,
  accountId: null,
  resourceId: null,
  pluginId: null,
  resourceTypeId: null,
  outputKey: null,
  status: "unknown",
  consecutiveFailures: 0,
  lastProbeAt: null,
  lastStatusCode: null,
  lastLatencyMs: null,
  lastError: null,
  lastStateChangeAt: null,
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAverages.mockResolvedValue(new Map([["probe:p1", 0.99]]));
});

describe("probe routes", () => {
  it("lists probes with their trailing uptime", async () => {
    mockList.mockResolvedValue([row]);
    const res = await app().request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.probes[0]).toMatchObject({ id: "p1", createdAt: "2026-11-01T00:00:00.000Z" });
  });

  it("creates from the well-typed fields only, answering 201 and auditing", async () => {
    mockCreate.mockResolvedValue(row);
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "API", url: row.url, intervalSeconds: "60", enabled: false }),
    });
    expect(res.status).toBe(201);
    // A field of the wrong type is ignored, as the Hono route ignored it.
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      { name: "API", url: row.url, enabled: false },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "probe.create" }));
    expect((await res.json()).uptime24h).toBeNull();
  });

  it("refuses a body without name and url in the route's words", async () => {
    const res = await app().request("/", { method: "POST", body: JSON.stringify({ name: 1 }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name and url are required" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a body that is not an object", async () => {
    const res = await app().request("/", { method: "POST", body: "[1]" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be an object" });
  });

  it("answers an empty update with No changes supplied", async () => {
    const res = await app().request("/p1", { method: "PUT", body: JSON.stringify({ x: 1 }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No changes supplied" });
  });

  it("answers the store's refusal with the status it carries", async () => {
    mockUpdate.mockRejectedValue(new FakeProbeInputError("Probe not found", 404));
    const res = await app().request("/p1", {
      method: "PUT",
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Probe not found" });
  });

  it("answers anything else from the store as the route's 500", async () => {
    mockDelete.mockRejectedValue(new Error("connection reset"));
    const res = await app().request("/p1", { method: "DELETE" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Probe operation failed" });
  });

  it("deletes with 204", async () => {
    mockDelete.mockResolvedValue(row);
    const res = await app().request("/p1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("validates the metrics range, and a metric store outage is a 503", async () => {
    mockGet.mockResolvedValue(row);
    const bad = await app().request("/p1/metrics?startMs=10&endMs=5");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: "startMs and endMs must be a valid epoch-ms range",
    });
    mockRange.mockRejectedValue(new Error("down"));
    const down = await app().request("/p1/metrics?startMs=1&endMs=5");
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "Metric store unavailable" });
  });

  it("gates writes on resources:write before reading the body", async () => {
    const res = await app(["resources:read"]).request("/", { method: "POST", body: "nope" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: resources:write" });
  });
});
