import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The scorecard store, the evaluator and the org grade reach Postgres and
// plugin feeds; these tests are about the transport.
class FakeScorecardInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockEnsure = vi.fn(async () => undefined);
vi.mock("@infrawrench/server-core/scorecards/store", () => ({
  ScorecardInputError: FakeScorecardInputError,
  createScorecardRecord: (...a: unknown[]) => mockCreate(...a),
  deleteScorecardRecord: vi.fn(),
  ensureDefaultScorecard: () => mockEnsure(),
  getScorecardRecord: (...a: unknown[]) => mockGet(...a),
  listScorecardRecords: vi.fn(async () => []),
  listScorecardResults: vi.fn(async () => []),
  scorecardToWire: (row: { id: string; checks: unknown[] }) => ({ id: row.id }),
  updateScorecardRecord: vi.fn(),
}));
const mockEvaluate = vi.fn();
vi.mock("@infrawrench/server-core/scorecards/eval", () => ({
  evaluateOrgScorecards: (...a: unknown[]) => mockEvaluate(...a),
}));
const mockGrade = vi.fn();
const mockTrend = vi.fn();
vi.mock("@infrawrench/server-core/scorecards/org-snapshots", () => ({
  getOrgScorecard: (...a: unknown[]) => mockGrade(...a),
  listOrgScorecardTrend: (...a: unknown[]) => mockTrend(...a),
}));
vi.mock("@infrawrench/server-core/service-catalog/store", () => ({
  listServiceRecords: vi.fn(async () => [
    { id: "svc-1", name: "Checkout", slug: "checkout", tier: 9, ownerTeam: null },
  ]),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { scorecardsDomain } = await import("@/http/domains/scorecards/index");
const basePath = "/api/org/org-1/scorecards";
const app = () => buildTestApi(scorecardsDomain, { basePath });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scorecard routes", () => {
  it("seeds the default on a list but never on the org grade", async () => {
    const list = await app().request("/");
    expect(list.status).toBe(200);
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    mockGrade.mockResolvedValue({ score: null, grade: null, pillars: [], failedPillars: [] });
    const grade = await app().request("/org");
    expect(grade.status).toBe(200);
    expect(mockGrade).toHaveBeenCalledWith("org-1");
    expect(mockEnsure).toHaveBeenCalledTimes(1);
  });

  it("checks the history window in the route's words", async () => {
    const bad = await app().request("/org/history?days=0");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "days must be a whole number between 1 and 400" });
    mockTrend.mockResolvedValue([]);
    const ok = await app().request("/org/history?days=30");
    expect(await ok.json()).toEqual({ trend: [] });
    expect(mockTrend).toHaveBeenCalledWith("org-1", { days: 30 });
  });

  it("fills the check defaults the route always filled", async () => {
    mockCreate.mockResolvedValue({ id: "sc1", checks: [] });
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Prod",
        checks: [{ id: "c1", type: "has_owner", params: { junk: { x: 1 } } }],
        levels: [{ key: "gold", name: "Gold" }],
      }),
    });
    expect(res.status).toBe(201);
    const input = mockCreate.mock.calls[0]![1];
    expect(input.checks).toEqual([
      { id: "c1", type: "has_owner", name: null, weight: 1, params: {} },
    ]);
    expect(input.levels[0]).toMatchObject({ key: "gold", name: "Gold", color: null });
    expect(Number.isNaN(input.levels[0].minScore)).toBe(true);
  });

  it("refuses a check type the registry does not know with the validator's sentence", async () => {
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "Prod", checks: [{ id: "c1", type: "made_up" }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown check type "made_up".' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses malformed tiers", async () => {
    const res = await app().request("/sc1", {
      method: "PATCH",
      body: JSON.stringify({ applicableTiers: [1, 5] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "applicableTiers must be an array of 1, 2, 3 or 4" });
  });

  it("evaluates one scorecard without announcing and answers the matrix", async () => {
    mockGet.mockResolvedValue({ id: "sc1" });
    mockEvaluate.mockResolvedValue({});
    const res = await app().request("/sc1/evaluate", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockEvaluate).toHaveBeenCalledWith("org-1", { scorecardIds: ["sc1"], announce: false });
    expect((await res.json()).services[0].tier).toBeNull();
  });

  it("answers an unknown scorecard with its 404 sentence", async () => {
    mockGet.mockResolvedValue(null);
    const res = await app().request("/sc1");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Scorecard not found" });
  });
});
