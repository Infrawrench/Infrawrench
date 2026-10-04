import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// Transport contract only: permissions, status mapping, the PDF response
// headers, and that "Send now" hands the store the web renderer. The store,
// delivery and rendering modules are mocked (they reach the Drizzle client).
const mockList = vi.fn();
const mockListOrg = vi.fn();
const mockTargets = vi.fn();
const mockRequireDashboard = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockSendNow = vi.fn();
const mockRenderDashboard = vi.fn();
const mockRenderReport = vi.fn();
const renderForDelivery = vi.fn();

class FakeInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

vi.mock("@infrawrench/server-core/report-delivery/store", () => ({
  ReportNotificationInputError: FakeInputError,
  listReportDeliveryTargets: (...args: unknown[]) => mockTargets(...args),
}));

vi.mock("@infrawrench/server-core/report-delivery/dashboard", () => ({
  listDashboardNotifications: (...args: unknown[]) => mockList(...args),
  listOrgDashboardNotifications: (...args: unknown[]) => mockListOrg(...args),
  requireLiveDashboard: (...args: unknown[]) => mockRequireDashboard(...args),
  createDashboardNotification: (...args: unknown[]) => mockCreate(...args),
  updateDashboardNotification: (...args: unknown[]) => mockUpdate(...args),
  deleteDashboardNotification: (...args: unknown[]) => mockDelete(...args),
  sendDashboardNotificationNow: (...args: unknown[]) => mockSendNow(...args),
}));

vi.mock("../../../services/dashboard-pdf", () => ({
  renderDashboardPdf: (...args: unknown[]) => mockRenderDashboard(...args),
  renderCostReportPdf: (...args: unknown[]) => mockRenderReport(...args),
  renderDashboardForDelivery: renderForDelivery,
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { dashboardNotificationRoutes, orgDashboardNotificationRoutes, costReportPdfRoutes } =
  await import("@/api/routes/dashboard-notifications");

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

const notification = {
  id: "n-1",
  dashboardId: "dash-1",
  cadence: "weekly",
  sendDay: 1,
  sendDayOfMonth: 1,
  hour: 8,
  timezone: "UTC",
  slackChannelIds: [],
  teamsWebhookIds: [],
  emailRecipients: ["finance@example.com"],
  enabled: true,
  attachPdf: true,
  nextSendAt: null,
  lastSentAt: null,
  lastStatus: null,
  lastError: null,
  createdByUserId: "user-1",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const input = {
  cadence: "weekly",
  sendDay: 1,
  hour: 8,
  timezone: "UTC",
  slackChannelIds: [],
  teamsWebhookIds: [],
  emailRecipients: ["finance@example.com"],
  enabled: true,
  attachPdf: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /dashboards/:id/pdf", () => {
  it("streams the PDF as an attachment", async () => {
    mockRenderDashboard.mockResolvedValue({ name: "Platform Costs", pdf: PDF });
    const app = buildTestApp(dashboardNotificationRoutes, ["dashboards:read", "costs:read"]);
    const res = await app.request("/dash-1/pdf?tz=Europe/Berlin");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("platform-costs.pdf");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(mockRenderDashboard).toHaveBeenCalledWith(expect.any(String), "dash-1", {
      canReadCosts: true,
      timezone: "Europe/Berlin",
    });
  });

  it("renders cost cards as a note without costs:read, and drops an unknown zone", async () => {
    mockRenderDashboard.mockResolvedValue({ name: "Ops", pdf: PDF });
    const app = buildTestApp(dashboardNotificationRoutes, ["dashboards:read"]);
    await app.request("/dash-1/pdf?tz=Nowhere/Land");
    expect(mockRenderDashboard).toHaveBeenCalledWith(expect.any(String), "dash-1", {
      canReadCosts: false,
      timezone: undefined,
    });
  });

  it("404s for a missing dashboard and 403s without dashboards:read", async () => {
    mockRenderDashboard.mockResolvedValue(null);
    expect(
      (await buildTestApp(dashboardNotificationRoutes, ["dashboards:read"]).request("/x/pdf"))
        .status,
    ).toBe(404);
    expect((await buildTestApp(dashboardNotificationRoutes, []).request("/x/pdf")).status).toBe(
      403,
    );
  });
});

describe("GET /cost-reports/:id/pdf", () => {
  it("needs costs:read", async () => {
    mockRenderReport.mockResolvedValue({ name: "Monthly", pdf: PDF });
    expect(
      (await buildTestApp(costReportPdfRoutes, ["dashboards:read"]).request("/r-1/pdf")).status,
    ).toBe(403);
    const res = await buildTestApp(costReportPdfRoutes, ["costs:read"]).request("/r-1/pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("monthly.pdf");
  });
});

describe("dashboard schedules", () => {
  it("lists with dashboards:read and maps a missing dashboard to 404", async () => {
    mockList.mockResolvedValue([notification]);
    const app = buildTestApp(dashboardNotificationRoutes, ["dashboards:read"]);
    expect(await (await app.request("/dash-1/notifications")).json()).toEqual([notification]);

    mockList.mockRejectedValue(new FakeInputError("Dashboard not found", 404));
    expect((await app.request("/gone/notifications")).status).toBe(404);
  });

  it("needs org:settings:write to create, and audits it", async () => {
    mockCreate.mockResolvedValue(notification);
    const denied = buildTestApp(dashboardNotificationRoutes, ["dashboards:read"]);
    const post = (app: typeof denied) =>
      app.request("/dash-1/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    expect((await post(denied)).status).toBe(403);

    const app = buildTestApp(dashboardNotificationRoutes, ["org:settings:write"]);
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(expect.any(String), "dash-1", input, expect.anything());
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dashboard_notification.create", entityId: "n-1" }),
    );
  });

  it("maps validation errors to 400", async () => {
    mockUpdate.mockRejectedValue(new FakeInputError("hour must be an integer from 0 to 23"));
    const app = buildTestApp(dashboardNotificationRoutes, ["org:settings:write"]);
    const res = await app.request("/dash-1/notifications/n-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, hour: 99 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "hour must be an integer from 0 to 23" });
  });

  it("checks the dashboard before listing targets", async () => {
    mockRequireDashboard.mockRejectedValue(new FakeInputError("Dashboard not found", 404));
    const app = buildTestApp(dashboardNotificationRoutes, ["org:settings:write"]);
    expect((await app.request("/gone/notifications/targets")).status).toBe(404);
    expect(mockTargets).not.toHaveBeenCalled();
  });

  it("sends now with the web renderer", async () => {
    const result = {
      attempted: 1,
      succeeded: 1,
      slack: { attempted: 0, succeeded: 0 },
      teams: { attempted: 0, succeeded: 0 },
      email: { attempted: 1, succeeded: 1 },
      pdfAttached: true,
      slackFilesUploaded: 0,
    };
    mockSendNow.mockResolvedValue(result);
    const app = buildTestApp(dashboardNotificationRoutes, ["org:settings:write"]);
    const res = await app.request("/dash-1/notifications/n-1/send", { method: "POST" });
    expect(await res.json()).toEqual(result);
    expect(mockSendNow).toHaveBeenCalledWith(
      expect.any(String),
      "dash-1",
      "n-1",
      renderForDelivery,
    );
  });

  it("deletes and lists org-wide", async () => {
    mockDelete.mockResolvedValue(undefined);
    const app = buildTestApp(dashboardNotificationRoutes, ["org:settings:write"]);
    expect((await app.request("/dash-1/notifications/n-1", { method: "DELETE" })).status).toBe(200);
    mockListOrg.mockResolvedValue([notification]);
    const org = buildTestApp(orgDashboardNotificationRoutes, ["dashboards:read"]);
    expect(await (await org.request("/")).json()).toEqual([notification]);
  });
});
