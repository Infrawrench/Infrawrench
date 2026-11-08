/**
 * The 400 a request that fails its schema gets: the route's sentence and the
 * issues, as every Zod-validated route sent. Decoding fails as a typed error
 * inside the middleware stack, which an empty framework 400 would otherwise
 * answer.
 */
import { describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

vi.mock("@/services/budgets", () => ({
  BudgetValidationError: class extends Error {},
  createBudget: vi.fn(),
  getBudgetWithStatus: vi.fn(),
  listBudgetEvents: vi.fn(),
  listBudgetsWithStatus: vi.fn(),
  softDeleteBudget: vi.fn(),
  updateBudget: vi.fn(),
}));
vi.mock("@/services/budget-alert-notes", () => ({
  BudgetAlertNoteError: class extends Error {},
  noteBudgetAlertEvent: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const { budgetsDomain } = await import("@/http/domains/budgets/index");
const app = buildTestApi(budgetsDomain, { basePath: "/api/org/org-1/budgets" });

describe("schema failures", () => {
  it("answer a bad payload with the route's sentence and every issue", async () => {
    const res = await app.request("/", { method: "POST", body: JSON.stringify({ name: 5 }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Array<{ path: unknown[] }> };
    expect(body.error).toBe("Invalid budget");
    const paths = body.issues.map((i) => i.path.join("."));
    expect(paths).toContain("name");
    expect(paths).toContain("thresholds");
  });

  it("answer a body that is not JSON with a 400 too", async () => {
    const res = await app.request("/", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });
});
