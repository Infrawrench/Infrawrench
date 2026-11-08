import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The store, the readers and the freeze service reach Postgres and
// ClickHouse; these tests are about the transport.
class FakeSloInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockGet = vi.fn();
vi.mock("@infrawrench/server-core/slos/store", () => ({
  SloInputError: FakeSloInputError,
  createSloRecord: (...a: unknown[]) => mockCreate(...a),
  updateSloRecord: (...a: unknown[]) => mockUpdate(...a),
  deleteSloRecord: vi.fn(),
  getSloRecord: (...a: unknown[]) => mockGet(...a),
  listSlosWire: vi.fn(async () => []),
  loadSloSourceLabels: vi.fn(async () => new Map()),
  sloToWire: (row: { id: string; name: string }) => ({ id: row.id, name: row.name }),
}));
vi.mock("@infrawrench/server-core/clickhouse/slo-readers", () => ({
  getSloHourlyBuckets: vi.fn(async () => []),
  listResourceMetricSeries: vi.fn(async () => []),
}));
vi.mock("@infrawrench/server-core/slos/eval", () => ({ sloMetricTarget: () => null }));
const mockFreeze = vi.fn();
vi.mock("@/services/change-freezes", () => ({
  createChangeFreeze: (...a: unknown[]) => mockFreeze(...a),
  getActiveChangeFreeze: vi.fn(async () => null),
}));
vi.mock("@/db/client", () => ({ db: {} }));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { slosDomain } = await import("@/http/domains/slos/index");
const basePath = "/api/org/org-1/slos";
const app = (permissions?: string[]) =>
  buildTestApi(slosDomain, { basePath, ...(permissions ? { permissions } : {}) });

const row = { id: "s1", name: "Checkout", sliKind: "probe_availability", windowDays: 30 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SLO routes", () => {
  it("creates from the picked fields, keeping nulls and dropping wrong types", async () => {
    mockCreate.mockResolvedValue(row);
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Checkout",
        sliKind: "probe_availability",
        probeId: "p1",
        description: null,
        threshold: "3",
        windowDays: 28,
      }),
    });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      {
        name: "Checkout",
        sliKind: "probe_availability",
        probeId: "p1",
        description: null,
        windowDays: 28,
      },
      "user-1",
    );
  });

  it("refuses values outside the closed sets in the route's words", async () => {
    const kind = await app().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "x", sliKind: "nope" }),
    });
    expect(kind.status).toBe(400);
    expect(await kind.json()).toEqual({
      error: "sliKind must be one of probe_availability, probe_latency, metric_threshold",
    });
    const cmp = await app().request("/s1", {
      method: "PUT",
      body: JSON.stringify({ comparator: "==" }),
    });
    expect(await cmp.json()).toEqual({ error: "comparator must be one of <, <=, >, >=" });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("answers an unknown SLO with its 404 sentence", async () => {
    mockGet.mockResolvedValue(null);
    const res = await app().request("/s1");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "SLO not found" });
  });

  it("starts a freeze named after the SLO, under freezes:write", async () => {
    mockGet.mockResolvedValue(row);
    mockFreeze.mockImplementation(async (_org: string, input: { name: string }) => ({
      id: "f1",
      name: input.name,
      startsAt: new Date("2026-11-08T00:00:00.000Z"),
      endsAt: new Date("2026-11-09T00:00:00.000Z"),
    }));
    const res = await app(["freezes:write"]).request("/s1/freeze", {
      method: "POST",
      body: JSON.stringify({ durationHours: 24 }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: "f1",
      name: "SLO budget: Checkout",
      endsAt: "2026-11-09T00:00:00.000Z",
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "change_freeze.create" }),
    );
  });

  it("refuses a duration outside the offered set", async () => {
    mockGet.mockResolvedValue(row);
    const res = await app().request("/s1/freeze", {
      method: "POST",
      body: JSON.stringify({ durationHours: 5 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "durationHours must be one of 24, 72, 168, " });
    expect(mockFreeze).not.toHaveBeenCalled();
  });

  it("gates the freeze on freezes:write", async () => {
    const res = await app(["resources:write"]).request("/s1/freeze", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: freezes:write" });
  });

  it("answers the store's conflict with 409", async () => {
    mockCreate.mockRejectedValue(new FakeSloInputError("An SLO with that name exists", 409));
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "x", sliKind: "probe_availability" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "An SLO with that name exists" });
  });
});
