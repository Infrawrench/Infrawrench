import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// The store and delivery modules are mocked rather than exercised: they reach
// the Drizzle client, which throws at import time without DATABASE_URL. These
// tests are about the transport contract — permissions (costs:read reads vs
// org:settings:write writes), status mapping for input errors, and the
// send-now route — which is what this file owns.
const mockList = vi.fn();
const mockListOrg = vi.fn();
const mockTargets = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockSendNow = vi.fn();

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
  listReportNotifications: (...args: unknown[]) => mockList(...args),
  listOrgReportNotifications: (...args: unknown[]) => mockListOrg(...args),
  listReportDeliveryTargets: (...args: unknown[]) => mockTargets(...args),
  createReportNotification: (...args: unknown[]) => mockCreate(...args),
  updateReportNotification: (...args: unknown[]) => mockUpdate(...args),
  deleteReportNotification: (...args: unknown[]) => mockDelete(...args),
}));

vi.mock("@infrawrench/server-core/report-delivery/deliver", () => ({
  sendReportNotificationNow: (...args: unknown[]) => mockSendNow(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costReportNotificationRoutes, orgReportNotificationRoutes } =
  await import("@/api/routes/cost-report-notifications");

const notification = {
  id: "n-1",
  costReportId: "report-1",
  cadence: "weekly",
  sendDay: 1,
  sendDayOfMonth: 1,
  hour: 8,
  timezone: "UTC",
  slackChannelIds: ["ch-1"],
  teamsWebhookIds: [],
  emailRecipients: ["finance@example.com"],
  enabled: true,
  nextSendAt: "2026-08-17T08:00:00.000Z",
  lastSentAt: null,
  lastStatus: null,
  lastError: null,
  createdByUserId: "user-1",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const input = {
  cadence: "weekly",
  sendDay: 1,
  hour: 8,
  timezone: "UTC",
  slackChannelIds: ["ch-1"],
  teamsWebhookIds: [],
  emailRecipients: ["finance@example.com"],
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /:id/notifications", () => {
  it("lists a report's schedules with costs:read", async () => {
    mockList.mockResolvedValue([notification]);
    const app = buildTestApp(costReportNotificationRoutes, ["costs:read"]);
    const res = await app.request("/report-1/notifications");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([notification]);
    expect(mockList).toHaveBeenCalledWith("org-1", "report-1");
  });

  it("maps a missing report onto 404", async () => {
    mockList.mockRejectedValue(new FakeInputError("Report not found", 404));
    const app = buildTestApp(costReportNotificationRoutes);
    const res = await app.request("/nope/notifications");
    expect(res.status).toBe(404);
  });

  it("refuses without costs:read", async () => {
    const app = buildTestApp(costReportNotificationRoutes, []);
    const res = await app.request("/report-1/notifications");
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("GET /:id/notifications/targets", () => {
  it("requires org:settings:write — the targets list is editor furniture", async () => {
    // costs:write deliberately does NOT open the schedule editor.
    const app = buildTestApp(costReportNotificationRoutes, ["costs:read", "costs:write"]);
    const res = await app.request("/report-1/notifications/targets");
    expect(res.status).toBe(403);
    expect(mockTargets).not.toHaveBeenCalled();
  });

  it("returns the target catalogue for a settings writer", async () => {
    mockTargets.mockResolvedValue({
      slackChannels: [{ id: "ch-1", label: "#finops" }],
      teamsWebhooks: [],
      emailAvailable: true,
    });
    const app = buildTestApp(costReportNotificationRoutes, ["org:settings:write"]);
    const res = await app.request("/report-1/notifications/targets");
    expect(res.status).toBe(200);
    expect((await res.json()).slackChannels).toHaveLength(1);
  });
});

describe("POST /:id/notifications", () => {
  it("creates with org:settings:write and audits it", async () => {
    mockCreate.mockResolvedValue(notification);
    const app = buildTestApp(costReportNotificationRoutes, ["org:settings:write"]);
    const res = await app.request("/report-1/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith("org-1", "report-1", input, "user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report_notification.create", entityId: "n-1" }),
    );
  });

  it("refuses costs:write — a schedule is spend egress, not curation", async () => {
    const app = buildTestApp(costReportNotificationRoutes, ["costs:read", "costs:write"]);
    const res = await app.request("/report-1/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps validation failures onto 400 with the store's message", async () => {
    mockCreate.mockRejectedValue(new FakeInputError("Unknown time zone: Not/AZone"));
    const app = buildTestApp(costReportNotificationRoutes, ["org:settings:write"]);
    const res = await app.request("/report-1/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, timezone: "Not/AZone" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Unknown time zone");
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe("PUT and DELETE /:id/notifications/:notificationId", () => {
  it("updates with org:settings:write and audits it", async () => {
    mockUpdate.mockResolvedValue({ ...notification, hour: 9 });
    const app = buildTestApp(costReportNotificationRoutes, ["org:settings:write"]);
    const res = await app.request("/report-1/notifications/n-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, hour: 9 }),
    });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("org-1", "report-1", "n-1", { ...input, hour: 9 });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report_notification.update" }),
    );
  });

  it("deletes with org:settings:write, 404s an unknown schedule", async () => {
    mockDelete.mockResolvedValue(undefined);
    const app = buildTestApp(costReportNotificationRoutes, ["org:settings:write"]);
    const res = await app.request("/report-1/notifications/n-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report_notification.delete", entityId: "n-1" }),
    );

    mockDelete.mockRejectedValue(new FakeInputError("Schedule not found", 404));
    const missing = await app.request("/report-1/notifications/nope", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});

describe("POST /:id/notifications/:notificationId/send", () => {
  const sendResult = {
    attempted: 3,
    succeeded: 3,
    slack: { attempted: 1, succeeded: 1 },
    teams: { attempted: 0, succeeded: 0 },
    email: { attempted: 2, succeeded: 2 },
  };

  it("sends now with org:settings:write, returns the per-transport outcome, audits", async () => {
    mockSendNow.mockResolvedValue(sendResult);
    const app = buildTestApp(costReportNotificationRoutes, ["org:settings:write"]);
    const res = await app.request("/report-1/notifications/n-1/send", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sendResult);
    expect(mockSendNow).toHaveBeenCalledWith("org-1", "report-1", "n-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "report_notification.send",
        entityId: "n-1",
        metadata: expect.objectContaining({ attempted: 3, succeeded: 3 }),
      }),
    );
  });

  it("surfaces a total delivery failure as a 400 the user can read", async () => {
    mockSendNow.mockRejectedValue(
      new FakeInputError("The report could not be delivered to any of its 3 destination(s)."),
    );
    const app = buildTestApp(costReportNotificationRoutes, ["org:settings:write"]);
    const res = await app.request("/report-1/notifications/n-1/send", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("could not be delivered");
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refuses without org:settings:write — send-now is immediate egress", async () => {
    const app = buildTestApp(costReportNotificationRoutes, ["costs:read", "costs:write"]);
    const res = await app.request("/report-1/notifications/n-1/send", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockSendNow).not.toHaveBeenCalled();
  });
});

describe("GET /cost-report-notifications (org-wide)", () => {
  it("lists every schedule with costs:read", async () => {
    mockListOrg.mockResolvedValue([notification]);
    const app = buildTestApp(orgReportNotificationRoutes, ["costs:read"]);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([notification]);
    expect(mockListOrg).toHaveBeenCalledWith("org-1");
  });

  it("refuses without costs:read", async () => {
    const app = buildTestApp(orgReportNotificationRoutes, []);
    const res = await app.request("/");
    expect(res.status).toBe(403);
  });
});
