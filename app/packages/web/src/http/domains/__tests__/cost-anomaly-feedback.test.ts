import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The service is mocked (it reaches the Drizzle client and ClickHouse). These
// tests own the transport contract of the anomaly feedback routes under
// /costs: permissions, the statuses the service's refusals map to, the 201 and
// 204 answers, and the precision window's bounds.
const mockSubmit = vi.fn();
const mockClear = vi.fn();
const mockList = vi.fn();
const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockSensitivity = vi.fn();
const mockPrecision = vi.fn();

class FakeFeedbackError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}
class FakeAcknowledgeError extends Error {}

vi.mock("../../../services/cost-anomaly-feedback", () => ({
  CostAnomalyFeedbackError: FakeFeedbackError,
  submitCostAnomalyFeedback: (...args: unknown[]) => mockSubmit(...args),
  clearCostAnomalyFeedback: (...args: unknown[]) => mockClear(...args),
  listCostAnomalySuppressions: (...args: unknown[]) => mockList(...args),
  createCostAnomalySuppression: (...args: unknown[]) => mockCreate(...args),
  getCostAnomalySuppression: (...args: unknown[]) => mockGet(...args),
  updateCostAnomalySuppression: (...args: unknown[]) => mockUpdate(...args),
  deleteCostAnomalySuppression: (...args: unknown[]) => mockDelete(...args),
  getCostAnomalySensitivity: (...args: unknown[]) => mockSensitivity(...args),
  getCostAnomalyPrecision: (...args: unknown[]) => mockPrecision(...args),
}));
vi.mock("../../../services/cost-anomalies", () => ({
  CostAnomalyAcknowledgeError: FakeAcknowledgeError,
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costAnomalyFeedbackDomain } = await import("@/http/domains/cost-anomaly-feedback/index");

const basePath = "/api/org/org-1/costs";
const buildApp = (permissions?: string[]) =>
  buildTestApi(costAnomalyFeedbackDomain, { basePath, ...(permissions ? { permissions } : {}) });

const anomaly = { id: "an-1", day: "2026-10-01", dimension: "service", dimensionKey: "EC2" };
const suppression = {
  id: "sup-1",
  scope: "service",
  scopeKey: "EC2",
  tagKey: null,
  scopeLabel: null,
  recurrence: "monthly",
  anchorDay: "2026-10-01",
  startsOn: "2026-10-01",
  expiresOn: "2027-04-01",
  reason: "seasonal",
  note: null,
  sourceAnomalyId: null,
  createdByUserId: "user-1",
  createdByName: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  active: true,
  suppressedCount: 0,
};
const suppressionInput = {
  scope: "service",
  scopeKey: "EC2",
  recurrence: "monthly",
  anchorDay: "2026-10-01",
  expiresOn: "2027-04-01",
};
const send = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmit.mockResolvedValue({ anomaly, suppression: null });
  mockClear.mockResolvedValue(anomaly);
  mockList.mockResolvedValue([suppression]);
  mockCreate.mockResolvedValue(suppression);
  mockGet.mockResolvedValue(suppression);
  mockUpdate.mockResolvedValue(suppression);
  mockDelete.mockResolvedValue(true);
  mockSensitivity.mockResolvedValue({
    enabled: true,
    windowDays: 90,
    baseSigmas: 3,
    adjustments: [],
  });
  mockPrecision.mockResolvedValue({ months: 6, periods: [], totals: {}, reasons: [] });
});

describe("POST /anomalies/:id/feedback", () => {
  it("is a write", async () => {
    const res = await buildApp(["costs:read"]).request(
      "/anomalies/an-1/feedback",
      send("POST", { verdict: "expected" }),
    );
    expect(res.status).toBe(403);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("records the verdict and audits it", async () => {
    const res = await buildApp().request(
      "/anomalies/an-1/feedback",
      send("POST", { verdict: "expected", reason: "seasonal" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ anomaly, suppression: null });
    expect(mockSubmit).toHaveBeenCalledWith(
      "org-1",
      "an-1",
      { verdict: "expected", reason: "seasonal" },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost_anomaly.feedback",
        entityId: "an-1",
        metadata: expect.objectContaining({ verdict: "expected", reason: "seasonal" }),
      }),
    );
  });

  it("refuses a verdict it does not know without calling the service", async () => {
    const res = await buildApp().request(
      "/anomalies/an-1/feedback",
      send("POST", { verdict: "maybe" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid feedback");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("maps the service's refusals to their statuses, and an unknown anomaly to 404", async () => {
    mockSubmit.mockRejectedValueOnce(new FakeFeedbackError("too many", 409));
    const conflict = await buildApp().request(
      "/anomalies/an-1/feedback",
      send("POST", { verdict: "expected" }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "too many" });

    mockSubmit.mockRejectedValueOnce(new FakeAcknowledgeError("no note"));
    const bad = await buildApp().request(
      "/anomalies/an-1/feedback",
      send("POST", { verdict: "expected" }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "no note" });

    mockSubmit.mockResolvedValueOnce(null);
    const missing = await buildApp().request(
      "/anomalies/an-1/feedback",
      send("POST", { verdict: "expected" }),
    );
    expect(missing.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe("DELETE /anomalies/:id/feedback", () => {
  it("withdraws the verdict and answers the anomaly", async () => {
    const res = await buildApp().request("/anomalies/an-1/feedback", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(anomaly);
    expect(mockClear).toHaveBeenCalledWith("org-1", "an-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_anomaly.feedback_clear" }),
    );
  });
});

describe("suppressions", () => {
  it("lists on costs:read", async () => {
    const res = await buildApp(["costs:read"]).request("/anomaly-suppressions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suppressions: [suppression] });
  });

  it("creates with a 201 and audits", async () => {
    const res = await buildApp().request("/anomaly-suppressions", send("POST", suppressionInput));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(suppression);
    expect(mockCreate).toHaveBeenCalledWith("org-1", suppressionInput, "user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_anomaly_suppression.create", entityId: "sup-1" }),
    );
  });

  it("answers the active-limit refusal with a 409", async () => {
    mockCreate.mockRejectedValueOnce(new FakeFeedbackError("limit", 409));
    const res = await buildApp().request("/anomaly-suppressions", send("POST", suppressionInput));
    expect(res.status).toBe(409);
  });

  it("refuses a malformed suppression with the route's sentence", async () => {
    const res = await buildApp().request(
      "/anomaly-suppressions",
      send("POST", { ...suppressionInput, anchorDay: "soon" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid suppression");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("gets, updates and 404s a missing one", async () => {
    expect((await buildApp().request("/anomaly-suppressions/sup-1")).status).toBe(200);
    const updated = await buildApp().request(
      "/anomaly-suppressions/sup-1",
      send("PUT", suppressionInput),
    );
    expect(updated.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("org-1", "sup-1", suppressionInput);

    mockGet.mockResolvedValueOnce(null);
    expect((await buildApp().request("/anomaly-suppressions/sup-2")).status).toBe(404);
  });

  it("deletes with an empty 204, and 404s what is not there", async () => {
    const res = await buildApp().request("/anomaly-suppressions/sup-1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_anomaly_suppression.delete", entityId: "sup-1" }),
    );

    mockDelete.mockResolvedValueOnce(false);
    const missing = await buildApp().request("/anomaly-suppressions/sup-1", {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
  });
});

describe("GET /anomaly-precision", () => {
  it("defaults the window and passes an explicit one through", async () => {
    await buildApp().request("/anomaly-precision");
    expect(mockPrecision).toHaveBeenLastCalledWith("org-1", 6);
    await buildApp().request("/anomaly-precision?months=12");
    expect(mockPrecision).toHaveBeenLastCalledWith("org-1", 12);
  });

  it("refuses a window outside its bounds with the route's own sentence", async () => {
    for (const months of ["0", "25", "1.5", "six"]) {
      const res = await buildApp().request(`/anomaly-precision?months=${months}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "months must be an integer between 1 and 24" });
    }
    expect(mockPrecision).not.toHaveBeenCalled();
  });
});

describe("GET /anomaly-sensitivity", () => {
  it("needs costs:read", async () => {
    expect((await buildApp([]).request("/anomaly-sensitivity")).status).toBe(403);
    expect((await buildApp(["costs:read"]).request("/anomaly-sensitivity")).status).toBe(200);
  });
});
