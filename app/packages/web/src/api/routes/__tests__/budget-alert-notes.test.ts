import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "./test-utils";

// Services are mocked: they reach the Drizzle client, which throws at import
// without DATABASE_URL. This file is about the note route's transport
// contract: permissions, validation, status codes and audit.
vi.mock("../../../services/budgets", () => ({
  createBudget: vi.fn(),
  getBudgetWithStatus: vi.fn(),
  listBudgetEvents: vi.fn(),
  listBudgetsWithStatus: vi.fn(),
  softDeleteBudget: vi.fn(),
  updateBudget: vi.fn(),
}));

const mockNote = vi.fn();
class FakeBudgetAlertNoteError extends Error {}
vi.mock("../../../services/budget-alert-notes", () => ({
  BudgetAlertNoteError: FakeBudgetAlertNoteError,
  noteBudgetAlertEvent: (...a: unknown[]) => mockNote(...a),
}));

class FakeSavedCostFilterResolutionError extends Error {}
vi.mock("@infrawrench/server-core/cost/saved-filters", () => ({
  SavedCostFilterResolutionError: FakeSavedCostFilterResolutionError,
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

const { budgetRoutes } = await import("@/api/routes/budgets");

const path = "/b1/events/e1/note";
const post = (body: unknown, permissions?: string[]) =>
  buildTestApp(budgetRoutes, permissions).request(path, {
    method: "POST",
    body: JSON.stringify(body),
  });

const result = {
  id: "e1",
  month: "2026-10",
  thresholdType: "actual",
  thresholdPercent: 80,
  actualAmountCents: 812000,
  forecastAmountCents: null,
  triggeredAt: "2026-10-03T14:05:00.000Z",
  note: {
    text: "Load test",
    notedAt: "2026-10-03T15:00:00.000Z",
    notedByUserId: "user-1",
    notedByName: "Test User",
    annotationId: "ann-1",
  },
  followUp: { slack: 1, msTeams: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockNote.mockResolvedValue(result);
});

describe("POST /:id/events/:eventId/note", () => {
  it("needs costs:write, not only budgets:read", async () => {
    const res = await post({ note: "Load test" }, ["budgets:read"]);
    expect(res.status).toBe(403);
    expect(mockNote).not.toHaveBeenCalled();
  });

  it("rejects an empty note without calling the service", async () => {
    const res = await post({ note: "" });
    expect(res.status).toBe(400);
    expect(mockNote).not.toHaveBeenCalled();
  });

  it("writes the note for the caller, returns the event and audits it", async () => {
    const res = await post({ note: "Load test" }, ["budgets:read", "costs:write"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mockNote).toHaveBeenCalledWith("org-1", "b1", "e1", "Load test", "user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "budget_alert.note", entityId: "b1" }),
    );
  });

  it("404s an unknown budget or event", async () => {
    mockNote.mockResolvedValue(null);
    expect((await post({ note: "Load test" })).status).toBe(404);
  });

  it("maps a rejected note onto 400", async () => {
    mockNote.mockRejectedValue(new FakeBudgetAlertNoteError("Keep the note short."));
    const res = await post({ note: "Load test" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Keep the note short." });
  });
});
