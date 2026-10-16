import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockGetReport = vi.fn();
const mockGetAlert = vi.fn();
const mockList = vi.fn();
const mockUpsert = vi.fn();
const mockDelete = vi.fn();
const mockOwned = vi.fn();
const mockCatalog = vi.fn();
const mockForeign = vi.fn();
const mockLogAudit = vi.fn();

class MockReportAnomalyAlertError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

vi.mock("@infrawrench/server-core/cost/report-anomaly-alerts", () => ({
  ReportAnomalyAlertError: MockReportAnomalyAlertError,
  getReportAnomalyAlert: (...a: unknown[]) => mockGetAlert(...a),
  listReportAnomalyAlerts: (...a: unknown[]) => mockList(...a),
  upsertReportAnomalyAlert: (...a: unknown[]) => mockUpsert(...a),
  deleteReportAnomalyAlert: (...a: unknown[]) => mockDelete(...a),
}));
vi.mock("@infrawrench/server-core/alerts/destinations", async () => {
  const shape = (d: { kind?: string; channelId?: string } | null) =>
    !d || !["push", "slack", "email-address"].includes(d.kind ?? "")
      ? `Unknown destination "${d?.kind ?? "?"}"`
      : d.kind === "slack" && !d.channelId
        ? "A Slack destination needs a channelId"
        : null;
  return {
    canonicalDestination: (d: unknown) => d,
    destinationShapeError: shape,
    foreignDestinationError: (...a: unknown[]) => mockForeign(...a),
    loadDestinationCatalog: (...a: unknown[]) => mockCatalog(...a),
    loadOwnedDestinations: (...a: unknown[]) => mockOwned(...a),
  };
});
vi.mock("../../../services/cost-reports", () => ({
  getCostReport: (...a: unknown[]) => mockGetReport(...a),
}));
vi.mock("../../../services/object-sharing", () => ({
  filterVisibleObjects: async (_org: string, _type: string, items: unknown[]) => items,
}));
vi.mock("../../../auth/cost-visibility", () => ({ visibilityUserIdForRequest: () => null }));
vi.mock("../../../services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { costReportAnomalyAlertRoutes, orgReportAnomalyAlertRoutes } =
  await import("@/api/routes/cost-report-anomaly-alerts");

const alert = {
  id: "a1",
  reportId: "r1",
  reportName: "Prod",
  enabled: true,
  sigmas: 3,
  minDeltaCents: 1000,
  destinations: [{ kind: "slack", channelId: "c1" }],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  lastEvaluatedAt: null,
  lastError: null,
  recent: [],
};
const valid = {
  enabled: true,
  sigmas: 3,
  minDeltaCents: 1000,
  destinations: [{ kind: "slack", channelId: "c1" }],
};
const put = (body: unknown) => ({
  method: "PUT",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetReport.mockResolvedValue({ id: "r1", name: "Prod" });
  mockGetAlert.mockResolvedValue(alert);
  mockUpsert.mockResolvedValue(alert);
  mockDelete.mockResolvedValue(true);
  mockOwned.mockResolvedValue({});
  mockForeign.mockReturnValue(null);
  mockCatalog.mockResolvedValue({ slackChannels: [] });
  mockList.mockResolvedValue([{ ...alert, reportCreatedByUserId: "u", reportFolderId: null }]);
});

describe("GET /cost-reports/:id/anomaly-alert", () => {
  it("reads with costs:read", async () => {
    const res = await buildTestApp(costReportAnomalyAlertRoutes, ["costs:read"]).request(
      "/r1/anomaly-alert",
    );
    expect(res.status).toBe(200);
    expect(mockGetAlert).toHaveBeenCalledWith("org-1", "r1");
  });

  it("is a 404 for a report the caller cannot see, and for a report without one", async () => {
    mockGetReport.mockResolvedValueOnce(null);
    const hidden = await buildTestApp(costReportAnomalyAlertRoutes).request("/r9/anomaly-alert");
    expect(hidden.status).toBe(404);
    expect(mockGetAlert).not.toHaveBeenCalled();
    mockGetAlert.mockResolvedValueOnce(null);
    const none = await buildTestApp(costReportAnomalyAlertRoutes).request("/r1/anomaly-alert");
    expect(none.status).toBe(404);
  });

  it("lists the destination catalog for settings writers only", async () => {
    const denied = await buildTestApp(costReportAnomalyAlertRoutes, ["costs:read"]).request(
      "/r1/anomaly-alert/targets",
    );
    expect(denied.status).toBe(403);
    const ok = await buildTestApp(costReportAnomalyAlertRoutes).request(
      "/r1/anomaly-alert/targets",
    );
    expect(ok.status).toBe(200);
  });
});

describe("PUT /cost-reports/:id/anomaly-alert", () => {
  it("needs org:settings:write, not just costs:write", async () => {
    const res = await buildTestApp(costReportAnomalyAlertRoutes, [
      "costs:read",
      "costs:write",
    ]).request("/r1/anomaly-alert", put(valid));
    expect(res.status).toBe(403);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("saves a valid alert as the caller and audits it", async () => {
    const res = await buildTestApp(costReportAnomalyAlertRoutes).request(
      "/r1/anomaly-alert",
      put(valid),
    );
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith("org-1", "r1", valid, {
      userId: "user-1",
      visibilityUserId: null,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_report_anomaly_alert.upsert", entityId: "r1" }),
    );
  });

  it("refuses an out-of-range sensitivity, an empty enabled alert and a malformed destination", async () => {
    const app = buildTestApp(costReportAnomalyAlertRoutes);
    expect((await app.request("/r1/anomaly-alert", put({ ...valid, sigmas: 20 }))).status).toBe(
      400,
    );
    expect(
      (await app.request("/r1/anomaly-alert", put({ ...valid, destinations: [] }))).status,
    ).toBe(400);
    const bad = await app.request(
      "/r1/anomaly-alert",
      put({ ...valid, destinations: [{ kind: "slack" }] }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "A Slack destination needs a channelId" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a destination this org does not own", async () => {
    mockForeign.mockReturnValueOnce("That Slack channel is not connected to this organization");
    const res = await buildTestApp(costReportAnomalyAlertRoutes).request(
      "/r1/anomaly-alert",
      put(valid),
    );
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("DELETE and the org list", () => {
  it("deletes and audits", async () => {
    const res = await buildTestApp(costReportAnomalyAlertRoutes).request("/r1/anomaly-alert", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("org-1", "r1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_report_anomaly_alert.delete" }),
    );
  });

  it("lists alerts without the sharing bookkeeping", async () => {
    const res = await buildTestApp(orgReportAnomalyAlertRoutes, ["costs:read"]).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: Array<Record<string, unknown>> };
    expect(body.alerts[0]).toMatchObject({ id: "a1", reportName: "Prod" });
    expect(body.alerts[0]).not.toHaveProperty("reportFolderId");
  });
});
