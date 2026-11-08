import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The allocation module is mocked: it reaches Drizzle, which throws at import
// time without DATABASE_URL. These tests own the transport contract:
// permissions, validation, status codes, error mapping, audit.
const svc = {
  listCentres: vi.fn(),
  createCentre: vi.fn(),
  updateCentre: vi.fn(),
  deleteCentre: vi.fn(),
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  swap: vi.fn(),
};

class FakeCostCentreError extends Error {}
class FakeAllocationRuleError extends Error {}

vi.mock("@infrawrench/server-core/cost/allocation", () => ({
  CostCentreError: FakeCostCentreError,
  AllocationRuleError: FakeAllocationRuleError,
  listCostCentres: (...a: unknown[]) => svc.listCentres(...a),
  createCostCentre: (...a: unknown[]) => svc.createCentre(...a),
  updateCostCentre: (...a: unknown[]) => svc.updateCentre(...a),
  deleteCostCentre: (...a: unknown[]) => svc.deleteCentre(...a),
  listAllocationRules: (...a: unknown[]) => svc.listRules(...a),
  createAllocationRule: (...a: unknown[]) => svc.createRule(...a),
  updateAllocationRule: (...a: unknown[]) => svc.updateRule(...a),
  deleteAllocationRule: (...a: unknown[]) => svc.deleteRule(...a),
  swapAllocationRulePriorities: (...a: unknown[]) => svc.swap(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costCentresDomain } = await import("@/http/domains/cost-centres/index");

const app = (permissions?: string[]) =>
  buildTestApi(costCentresDomain, {
    basePath: "/api/org/org-1/cost-centres",
    ...(permissions ? { permissions } : {}),
  });

const send = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const centre = {
  id: "cc-1",
  name: "Platform",
  description: null,
  parentId: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const rule = {
  id: "r-1",
  costCentreId: "cc-1",
  priority: 10,
  match: { tagKey: "team", tagValue: "platform" },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  svc.listCentres.mockResolvedValue([centre]);
  svc.createCentre.mockResolvedValue(centre);
  svc.updateCentre.mockResolvedValue(centre);
  svc.deleteCentre.mockResolvedValue(true);
  svc.listRules.mockResolvedValue([rule]);
  svc.createRule.mockResolvedValue(rule);
  svc.updateRule.mockResolvedValue(rule);
  svc.deleteRule.mockResolvedValue(true);
  svc.swap.mockResolvedValue([rule]);
});

describe("cost centres", () => {
  it("reads with costs:read and refuses writes without costs:write", async () => {
    const res = await app(["costs:read"]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([centre]);
    const write = await app(["costs:read"]).request("/", send("POST", { name: "Platform" }));
    expect(write.status).toBe(403);
    expect(svc.createCentre).not.toHaveBeenCalled();
  });

  it("creates with the decoded body and audits", async () => {
    const res = await app().request("/", send("POST", { name: "Platform", parentId: null }));
    expect(res.status).toBe(200);
    expect(svc.createCentre).toHaveBeenCalledWith("org-1", { name: "Platform", parentId: null });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost_centre.create",
        entityId: "cc-1",
        metadata: { name: "Platform", parentId: null },
      }),
    );
  });

  it("refuses an invalid body with the route's sentence", async () => {
    const res = await app().request("/", send("POST", { name: "" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid cost centre" });
    expect(svc.createCentre).not.toHaveBeenCalled();
  });

  it("maps a rejected placement to a 400 with its message", async () => {
    svc.updateCentre.mockRejectedValue(new FakeCostCentreError("too deep"));
    const res = await app().request("/cc-1", send("PUT", { name: "Platform", parentId: "cc-9" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too deep" });
  });

  it("404s an unknown centre on update and delete", async () => {
    svc.updateCentre.mockResolvedValue(null);
    svc.deleteCentre.mockResolvedValue(false);
    expect((await app().request("/nope", send("PUT", { name: "X" }))).status).toBe(404);
    const del = await app().request("/nope", { method: "DELETE" });
    expect(del.status).toBe(404);
    expect(await del.json()).toEqual({ error: "Not found" });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("deletes and audits", async () => {
    const res = await app().request("/cc-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_centre.delete", entityId: "cc-1" }),
    );
  });
});

describe("allocation rules", () => {
  const input = { costCentreId: "cc-1", priority: 10, match: { tagKey: "team" } };

  it("lists rules rather than reading `rules` as a centre id", async () => {
    const res = await app(["costs:read"]).request("/rules");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([rule]);
  });

  it("refuses a tag value without its key", async () => {
    const res = await app().request(
      "/rules",
      send("POST", { ...input, match: { tagValue: "platform" } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid allocation rule" });
  });

  it("answers an unknown centre with 404 and any other failure with the route's 400", async () => {
    svc.createRule.mockResolvedValueOnce(null);
    const missing = await app().request("/rules", send("POST", input));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Cost centre not found" });

    svc.createRule.mockRejectedValueOnce(new FakeAllocationRuleError("bad match"));
    const refused = await app().request("/rules", send("POST", input));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "bad match" });

    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    svc.createRule.mockRejectedValueOnce(new Error("db down"));
    const failed = await app().request("/rules", send("POST", input));
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "Failed to create allocation rule" });
    spy.mockRestore();
  });

  it("swaps two rules, refusing a rule with itself and unknown ids", async () => {
    const res = await app().request("/rules/swap", send("POST", { aId: "r-1", bId: "r-2" }));
    expect(res.status).toBe(200);
    expect(svc.swap).toHaveBeenCalledWith("org-1", "r-1", "r-2");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_allocation_rule.swap", entityId: "r-1" }),
    );

    const self = await app().request("/rules/swap", send("POST", { aId: "r-1", bId: "r-1" }));
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({ error: "Cannot swap a rule with itself" });

    svc.swap.mockResolvedValueOnce(null);
    const missing = await app().request("/rules/swap", send("POST", { aId: "r-1", bId: "r-9" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "One or both rules not found" });

    const invalid = await app().request("/rules/swap", send("POST", { aId: "" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "Invalid swap request" });
  });

  it("updates and deletes a rule", async () => {
    const put = await app().request("/rules/r-1", send("PUT", input));
    expect(put.status).toBe(200);
    expect(svc.updateRule).toHaveBeenCalledWith("org-1", "r-1", input);
    const del = await app().request("/rules/r-1", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_allocation_rule.delete", entityId: "r-1" }),
    );
  });
});
