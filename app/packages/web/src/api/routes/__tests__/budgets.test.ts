import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// The service is mocked (it reaches the Drizzle client). These tests are about
// the transport contract for the budget shapes added with hierarchies, usage
// budgets and flexible periods: the schema accepts them, and a write the
// service refuses (a cycle, a mismatched unit, an invalid combination) is a
// 400 carrying the service's sentence. The rules themselves are client-core's
// `budgetInputError` (tested there) plus the service's hierarchy checks.
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

class FakeBudgetValidationError extends Error {}

vi.mock("../../../services/budgets", () => ({
  BudgetValidationError: FakeBudgetValidationError,
  createBudget: (...args: unknown[]) => mockCreate(...args),
  updateBudget: (...args: unknown[]) => mockUpdate(...args),
  getBudgetWithStatus: vi.fn(),
  listBudgetEvents: vi.fn(),
  listBudgetsWithStatus: vi.fn(async () => []),
  softDeleteBudget: vi.fn(),
}));

class FakeSavedFilterError extends Error {}
// The routes also mount the alert-note endpoint; its service reaches the
// database and chat clients, none of which these tests exercise.
vi.mock("../../../services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("../../../services/budget-alert-notes", () => ({
  BudgetAlertNoteError: class extends Error {},
  noteBudgetAlertEvent: vi.fn(),
}));
vi.mock("@infrawrench/server-core/cost/saved-filters", () => ({
  SavedCostFilterResolutionError: FakeSavedFilterError,
}));

const { budgetRoutes } = await import("@/api/routes/budgets");
const buildApp = () => buildTestApp(budgetRoutes);

const post = (body: unknown) =>
  buildApp().request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ id: "b1" });
});

describe("budget routes", () => {
  it("accepts a usage budget on a custom cadence under a parent, with no amountCents", async () => {
    const res = await post({
      name: "Tokens",
      measure: "usage",
      usageUnit: "tokens",
      usageAmount: 5_000_000,
      period: { kind: "recurring", unit: "week", interval: 2, startDate: "2026-10-05" },
      parentBudgetId: "parent-1",
      thresholds: [{ type: "forecast", percent: 90 }],
    });
    expect(res.status).toBe(200);
    expect(mockCreate.mock.calls[0]![1]).toMatchObject({
      amountCents: 0,
      measure: "usage",
      usageAmount: 5_000_000,
      period: { kind: "recurring", interval: 2 },
      parentBudgetId: "parent-1",
    });
  });

  it("accepts an explicit period list", async () => {
    const res = await post({
      name: "Launch",
      period: {
        kind: "explicit",
        periods: [{ start: "2026-11-01", end: "2026-11-30", amountCents: 500_000 }],
      },
      thresholds: [{ type: "actual", percent: 100 }],
    });
    expect(res.status).toBe(200);
  });

  it("rejects an out-of-range interval at the schema", async () => {
    const res = await post({
      name: "Bad",
      amountCents: 100,
      period: { kind: "recurring", unit: "day", interval: 0, startDate: "2026-10-05" },
      thresholds: [{ type: "actual", percent: 100 }],
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("turns a refused hierarchy write into a 400 with the service's reason", async () => {
    mockUpdate.mockRejectedValue(
      new FakeBudgetValidationError("A budget cannot roll up into one of its own children."),
    );
    const res = await buildApp().request("/b1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Loop",
        amountCents: 100,
        parentBudgetId: "child-1",
        thresholds: [{ type: "actual", percent: 100 }],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "A budget cannot roll up into one of its own children.",
    });
  });
});
