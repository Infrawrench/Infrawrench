import { describe, it, expect, vi, beforeEach } from "vitest";
import { CostQueryError } from "../../services/cost-query";

const mockRunCostQuery = vi.fn();
const mockListDimensionValues = vi.fn();
const mockListTagKeys = vi.fn();
const mockGetOrgCostStatus = vi.fn();
// The tag-policy modules reach the db client at import time, which requires
// DATABASE_URL — stub them like the other server-core imports below.
// Same DATABASE_URL reason: the saved-filter service and the commitments feed
// both reach a db client at import time. Behaviour lives in their own tests
// (services/__tests__ and api/routes/__tests__/saved-filters.test.ts).
vi.mock("../../services/saved-cost-filters", () => ({
  listSavedCostFilters: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../services/cost-scenarios", () => ({
  listCostScenarioModels: vi.fn().mockResolvedValue([]),
}));
vi.mock("@infrawrench/server-core/commitments/feed", () => ({
  getCommitmentsFeed: vi.fn().mockResolvedValue([]),
}));
// The billing-rule resolver reaches Postgres at import time. Nothing here asks
// for an adjusted answer, so it is never called — it only has to exist.
vi.mock("@infrawrench/server-core/cost/billing-rules", () => ({
  resolveBillingAdjustments: vi.fn(),
  listBillingRules: vi.fn(async () => []),
}));

vi.mock("@infrawrench/server-core/cost/tag-policy", () => ({
  getOrgTagPolicy: vi.fn().mockResolvedValue(null),
  setOrgTagPolicy: vi.fn(),
}));
vi.mock("../../services/tag-policy", () => ({
  getUntaggedSpendReport: vi.fn(),
  getAccountTagCompliance: vi.fn(),
}));
vi.mock("../../services/showback", () => ({
  getShowbackReport: vi.fn(),
}));

// Not importOriginal: the real module pulls in db/client, which requires
// DATABASE_URL at import time. The class only needs to be instance-shared.
vi.mock("../../services/cost-query", () => ({
  CostQueryError: class CostQueryError extends Error {},
  runCostQuery: (...a: unknown[]) => mockRunCostQuery(...a),
  listCostDimensionValues: (...a: unknown[]) => mockListDimensionValues(...a),
  listCostTagKeys: (...a: unknown[]) => mockListTagKeys(...a),
  getOrgCostStatus: (...a: unknown[]) => mockGetOrgCostStatus(...a),
}));

const mockListBudgets = vi.fn();
const mockGetBudget = vi.fn();
const mockListEvents = vi.fn();
const mockCreateBudget = vi.fn();
const mockUpdateBudget = vi.fn();
const mockDeleteBudget = vi.fn();
vi.mock("../../services/budgets", () => ({
  listBudgetsWithStatus: (...a: unknown[]) => mockListBudgets(...a),
  getBudgetWithStatus: (...a: unknown[]) => mockGetBudget(...a),
  listBudgetEvents: (...a: unknown[]) => mockListEvents(...a),
  createBudget: (...a: unknown[]) => mockCreateBudget(...a),
  updateBudget: (...a: unknown[]) => mockUpdateBudget(...a),
  softDeleteBudget: (...a: unknown[]) => mockDeleteBudget(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("../../services/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

const mockResolvePerms = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: (...a: unknown[]) => mockResolvePerms(...a),
}));

const { costTools } = await import("../costs");
const tools = costTools();
const tool = (name: string) => tools.find((t) => t.name === name)!;
const auth = { userId: "u1", organizationId: "o1", source: "mcp" as const };

const validQuery = {
  from: "2026-07-01",
  to: "2026-07-20",
  binning: "daily",
  groupBy: "provider",
};

function grant(...permissions: string[]) {
  mockResolvePerms.mockResolvedValue({ permissions, role: null });
}

describe("costTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grant("costs:read", "budgets:read", "budgets:write");
  });

  it("query_costs denies callers without costs:read", async () => {
    grant("resources:read");
    const r = await tool("query_costs").handler(validQuery, auth);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("costs:read");
    expect(mockRunCostQuery).not.toHaveBeenCalled();
  });

  it("query_costs applies schema defaults and runs the query", async () => {
    mockRunCostQuery.mockResolvedValue({ series: [], currencies: [], totals: {} });
    const r = await tool("query_costs").handler(validQuery, auth);
    expect(r.isError).toBeFalsy();
    expect(mockRunCostQuery).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ topN: 5, filters: [], comparePreviousPeriod: false }),
    );
  });

  it("query_costs surfaces CostQueryError as a tool error", async () => {
    mockRunCostQuery.mockRejectedValue(new CostQueryError("from must not be after to"));
    const r = await tool("query_costs").handler(validQuery, auth);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("from must not be after to");
  });

  it("query_costs rejects malformed input", async () => {
    const r = await tool("query_costs").handler({ ...validQuery, binning: "hourly" }, auth);
    expect(r.isError).toBe(true);
    expect(mockRunCostQuery).not.toHaveBeenCalled();
  });

  it("list_cost_dimension_values routes tag-keys to the tag-key lister", async () => {
    mockListTagKeys.mockResolvedValue(["env", "team"]);
    const r = await tool("list_cost_dimension_values").handler({ dimension: "tag-keys" }, auth);
    expect(JSON.parse(r.content[0]!.text)).toEqual(["env", "team"]);
    expect(mockListDimensionValues).not.toHaveBeenCalled();
  });

  it("get_cost_status returns per-account coverage", async () => {
    mockGetOrgCostStatus.mockResolvedValue([{ accountId: "a1", supportsCosts: true }]);
    const r = await tool("get_cost_status").handler({}, auth);
    expect(JSON.parse(r.content[0]!.text)[0].accountId).toBe("a1");
  });

  it("list_budgets denies callers without budgets:read", async () => {
    grant("costs:read");
    const r = await tool("list_budgets").handler({}, auth);
    expect(r.isError).toBe(true);
    expect(mockListBudgets).not.toHaveBeenCalled();
  });

  it("get_budget merges status and alert history", async () => {
    mockGetBudget.mockResolvedValue({ id: "b1", name: "Prod", actualCents: 100 });
    mockListEvents.mockResolvedValue([{ id: "e1" }]);
    const r = await tool("get_budget").handler({ budgetId: "b1" }, auth);
    const out = JSON.parse(r.content[0]!.text);
    expect(out.name).toBe("Prod");
    expect(out.events).toEqual([{ id: "e1" }]);
  });

  it("create_budget validates, creates, and audit-logs", async () => {
    mockCreateBudget.mockResolvedValue({ id: "b1", name: "Prod", amountCents: 50000 });
    const input = {
      name: "Prod",
      amountCents: 50000,
      thresholds: [{ type: "actual", percent: 80 }],
    };
    const r = await tool("create_budget").handler(input, auth);
    expect(r.isError).toBeFalsy();
    expect(mockCreateBudget).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ currency: "USD", filters: [] }),
      "u1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "budget.create", entityId: "b1" }),
    );
  });

  it("create_budget rejects invalid thresholds without writing", async () => {
    const r = await tool("create_budget").handler(
      { name: "Prod", amountCents: 50000, thresholds: [] },
      auth,
    );
    expect(r.isError).toBe(true);
    expect(mockCreateBudget).not.toHaveBeenCalled();
  });

  it("update_budget errors when the budget is missing", async () => {
    mockUpdateBudget.mockResolvedValue(null);
    const r = await tool("update_budget").handler(
      {
        budgetId: "ghost",
        name: "Prod",
        amountCents: 1,
        thresholds: [{ type: "actual", percent: 100 }],
      },
      auth,
    );
    expect(r.isError).toBe(true);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("delete_budget soft-deletes and audit-logs", async () => {
    mockDeleteBudget.mockResolvedValue(true);
    const r = await tool("delete_budget").handler({ budgetId: "b1" }, auth);
    expect(r.isError).toBeFalsy();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "budget.delete", entityId: "b1" }),
    );
  });

  it("delete_budget is registered as destructive so chat gates it", () => {
    expect(tool("delete_budget").risk).toBe("destructive");
    expect(tool("create_budget").risk).toBe("write");
    expect(tool("query_costs").risk).toBe("read");
  });
});
