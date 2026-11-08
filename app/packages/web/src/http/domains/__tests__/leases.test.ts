import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// Lease bodies are checked by hand, each 400 naming the field at fault, and
// the store's refusals keep the status they carry.
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockGetRecord = vi.fn();
const mockGetWire = vi.fn();

class FakeLeaseInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

vi.mock("@/services/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@infrawrench/server-core/leases/store", () => ({
  LeaseInputError: FakeLeaseInputError,
  createLeaseRecord: (...args: unknown[]) => mockCreate(...args),
  updateLeaseRecord: (...args: unknown[]) => mockUpdate(...args),
  getLeaseRecord: (...args: unknown[]) => mockGetRecord(...args),
  getLeaseWire: (...args: unknown[]) => mockGetWire(...args),
  cancelLeaseRecord: vi.fn(),
  deleteLeaseRecord: vi.fn(async () => ({ id: "l1", resourceId: "r1", pluginId: "aws" })),
  getLeaseWireByResource: vi.fn(async () => null),
  listLeases: vi.fn(async () => ({ leases: [] })),
}));

const { leasesDomain } = await import("@/http/domains/leases/index");
const basePath = "/api/org/org-1/leases";
const buildApp = (permissions?: readonly string[]) =>
  buildTestApi(leasesDomain, { basePath, ...(permissions ? { permissions } : {}) });

const created = {
  id: "l1",
  resourceId: "r1",
  pluginId: "aws",
  resourceTypeId: "ec2",
  expiresAt: new Date("2030-01-01T00:00:00Z"),
  autoDelete: false,
};

const valid = { resourceId: "r1", accountId: "a1", expiresAt: "2030-01-01T00:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(created);
  mockGetWire.mockResolvedValue({ id: "l1", resourceId: "r1" });
});

describe("lease routes", () => {
  it("creates a lease with 201 and the wire row", async () => {
    const res = await buildApp().request("/", { method: "POST", body: JSON.stringify(valid) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "l1", resourceId: "r1" });
    expect(mockCreate.mock.calls[0]![1]).toEqual(valid);
  });

  it.each([
    [{ accountId: "a1", expiresAt: "x" }, "resourceId and accountId are required"],
    [{ resourceId: "r1", accountId: "a1" }, "expiresAt is required (ISO 8601)"],
    [{ ...valid, autoDelete: "yes" }, "autoDelete must be a boolean"],
    [{ ...valid, note: 3 }, "note must be a string"],
  ])("refuses %j with the field's sentence", async (body, error) => {
    const res = await buildApp().request("/", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it("refuses a body that is not an object", async () => {
    const res = await buildApp().request("/", { method: "POST", body: "[]" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be an object" });
  });

  it("needs resources:delete for an auto-delete lease", async () => {
    const res = await buildApp(["resources:write"]).request("/", {
      method: "POST",
      body: JSON.stringify({ ...valid, autoDelete: true }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: resources:delete" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("answers a second active lease with the store's 409", async () => {
    mockCreate.mockRejectedValue(new FakeLeaseInputError("Already leased", 409));
    const res = await buildApp().request("/", { method: "POST", body: JSON.stringify(valid) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Already leased" });
  });

  it("hides an unexpected failure behind the route's sentence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockCreate.mockRejectedValue(new Error("connection reset"));
    const res = await buildApp().request("/", { method: "POST", body: JSON.stringify(valid) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Lease operation failed" });
  });

  it("needs resources:delete to reshape a lease that stays armed", async () => {
    mockGetRecord.mockResolvedValue({ autoDelete: true });
    const res = await buildApp(["resources:write"]).request("/l1", {
      method: "PUT",
      body: JSON.stringify({ expiresAt: "2030-02-01T00:00:00Z" }),
    });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses an empty patch", async () => {
    const res = await buildApp().request("/l1", { method: "PUT", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No changes supplied" });
  });

  it("deletes with 204 and no body", async () => {
    const res = await buildApp().request("/l1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("asks for resourceId on the lookup", async () => {
    const res = await buildApp().request("/resource?resourceId=", { method: "GET" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing resourceId" });
  });
});
