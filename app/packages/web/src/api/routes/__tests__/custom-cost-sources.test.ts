import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// The service is mocked: it reaches Drizzle and ClickHouse. These tests own the
// transport contract: permissions, validation, status codes, audit.
const svc = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listUploads: vi.fn(),
  createUpload: vi.fn(),
  append: vi.fn(),
  complete: vi.fn(),
  removeUpload: vi.fn(),
};

class FakeCustomCostError extends Error {}
class FakeCostIngestError extends Error {}
class FakeOverlapError extends Error {
  constructor(public readonly overlapping: unknown[]) {
    super("overlaps");
  }
}

vi.mock("@infrawrench/server-core/cost/custom-costs", () => ({
  CustomCostError: FakeCustomCostError,
  CostIngestError: FakeCostIngestError,
  CustomCostOverlapError: FakeOverlapError,
  listCustomCostSources: (...a: unknown[]) => svc.list(...a),
  getCustomCostSource: (...a: unknown[]) => svc.get(...a),
  createCustomCostSource: (...a: unknown[]) => svc.create(...a),
  updateCustomCostSource: (...a: unknown[]) => svc.update(...a),
  deleteCustomCostSource: (...a: unknown[]) => svc.remove(...a),
  listCustomCostUploads: (...a: unknown[]) => svc.listUploads(...a),
  createCustomCostUpload: (...a: unknown[]) => svc.createUpload(...a),
  appendCustomCostRows: (...a: unknown[]) => svc.append(...a),
  completeCustomCostUpload: (...a: unknown[]) => svc.complete(...a),
  deleteCustomCostUpload: (...a: unknown[]) => svc.removeUpload(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { customCostSourceRoutes } = await import("@/api/routes/custom-cost-sources");

const app = (permissions?: string[]) => buildTestApp(customCostSourceRoutes, permissions);
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const source = { id: "s1", name: "Colo", pluginId: "custom:s1" };

beforeEach(() => {
  vi.clearAllMocks();
  svc.list.mockResolvedValue([source]);
  svc.get.mockResolvedValue(source);
  svc.create.mockResolvedValue(source);
});

describe("sources", () => {
  it("reads with costs:read and refuses writes without costs:write", async () => {
    expect((await app(["costs:read"]).request("/")).status).toBe(200);
    expect((await app(["costs:read"]).request("/", post({ name: "Colo" }))).status).toBe(403);
  });

  it("creates, audits, and maps service validation errors to 400", async () => {
    const res = await app().request("/", post({ name: "Colo", defaultCurrency: "EUR" }));
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "custom_cost_source.create", entityId: "s1" }),
    );
    svc.create.mockRejectedValueOnce(new FakeCustomCostError("taken"));
    const dup = await app().request("/", post({ name: "Colo" }));
    expect(dup.status).toBe(400);
    expect(await dup.json()).toEqual({ error: "taken" });
  });

  it("404s a delete of an unknown source", async () => {
    svc.remove.mockResolvedValue({ deleted: false, zeroedRows: 0 });
    expect((await app().request("/nope", { method: "DELETE" })).status).toBe(404);
  });
});

describe("uploads", () => {
  it("answers 409 with the overlapping uploads when no mode was chosen", async () => {
    svc.createUpload.mockRejectedValue(new FakeOverlapError([{ id: "u0" }]));
    const res = await app().request(
      "/s1/uploads",
      post({ format: "csv", fromDate: "2026-07-01", toDate: "2026-07-31" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "overlap", overlapping: [{ id: "u0" }] });
  });

  it("rejects an oversized chunk before reaching the service", async () => {
    const rows = Array.from({ length: 5001 }, () => ({}));
    const res = await app().request("/s1/uploads/u1/rows", post({ rows }));
    expect(res.status).toBe(400);
    expect(svc.append).not.toHaveBeenCalled();
  });

  it("maps row validation errors to 400", async () => {
    svc.append.mockRejectedValue(new FakeCostIngestError("row 0 bad"));
    const res = await app().request("/s1/uploads/u1/rows", post({ rows: [{}] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "row 0 bad" });
  });

  it("audits a completed upload with its replace count", async () => {
    svc.complete.mockResolvedValue({
      upload: { id: "u1", fileName: "bill.csv", rowCount: 3, mode: "replace" },
      replacedRows: 7,
    });
    const res = await app().request("/s1/uploads/u1/complete", post({}));
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "custom_cost_upload.complete",
        metadata: expect.objectContaining({ replacedRows: 7, rows: 3 }),
      }),
    );
  });
});
