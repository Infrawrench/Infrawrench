import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The service is mocked (it reaches the Drizzle client). These tests own the
// transport contract of change-based cost alerts: permissions, the events
// feed's query handling, the refusals that are 400s, and the audit trail.
const mockList = vi.fn();
const mockEvents = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
class FakeLimitError extends Error {}
class FakeRecipientsError extends Error {}

vi.mock("../../../services/cost-alerts", () => ({
  CostAlertLimitError: FakeLimitError,
  listCostAlerts: (...args: unknown[]) => mockList(...args),
  listCostAlertEventsForOrg: (...args: unknown[]) => mockEvents(...args),
  getCostAlert: (...args: unknown[]) => mockGet(...args),
  createCostAlert: (...args: unknown[]) => mockCreate(...args),
  updateCostAlert: (...args: unknown[]) => mockUpdate(...args),
  softDeleteCostAlert: (...args: unknown[]) => mockDelete(...args),
}));
vi.mock("@infrawrench/server-core/alerts/email-errors", () => ({
  AlertEmailRecipientsError: FakeRecipientsError,
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costAlertsDomain } = await import("@/http/domains/cost-alerts/index");

const basePath = "/api/org/org-1/cost-alerts";
const buildApp = (permissions?: string[]) =>
  buildTestApi(costAlertsDomain, { basePath, ...(permissions ? { permissions } : {}) });

const alert = {
  id: "ca-1",
  name: "Spend jump",
  filters: [],
  groupBy: null,
  groupByTagKey: null,
  cadence: "daily",
  thresholdPercent: 20,
  thresholdAmountCents: null,
  direction: "increase",
  enabled: true,
  lastEvaluatedAt: null,
  lastFiredAt: null,
  emailRecipients: { userIds: [], addresses: [] },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const input = { name: "Spend jump", cadence: "daily", thresholdPercent: 20, direction: "increase" };
const send = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([alert]);
  mockEvents.mockResolvedValue([]);
  mockGet.mockResolvedValue(alert);
  mockCreate.mockResolvedValue(alert);
  mockUpdate.mockResolvedValue(alert);
  mockDelete.mockResolvedValue(true);
});

describe("reads", () => {
  it("need costs:read", async () => {
    expect((await buildApp([]).request("/")).status).toBe(403);
    const res = await buildApp(["costs:read"]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alerts: [alert] });
  });

  it("route /events to the feed rather than to an alert called events", async () => {
    const res = await buildApp().request("/events?alertId=ca-1&limit=5");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
    expect(mockEvents).toHaveBeenCalledWith("org-1", { alertId: "ca-1", limit: 5 });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("refuses a limit that is not a positive integer, and 404s an unknown alert", async () => {
    for (const limit of ["0", "-1", "2.5", "lots"]) {
      const res = await buildApp().request(`/events?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "limit must be a positive integer" });
    }
    mockEvents.mockResolvedValueOnce(null);
    expect((await buildApp().request("/events?alertId=nope")).status).toBe(404);
  });

  it("404s an unknown alert", async () => {
    mockGet.mockResolvedValueOnce(null);
    expect((await buildApp().request("/ca-2")).status).toBe(404);
  });
});

describe("writes", () => {
  it("need costs:write", async () => {
    const res = await buildApp(["costs:read"]).request("/", send("POST", input));
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("create with the defaults filled in, and audit", async () => {
    const res = await buildApp().request("/", send("POST", input));
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ ...input, filters: [], groupBy: null, enabled: true }),
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_alert.create", entityId: "ca-1" }),
    );
  });

  it("refuse an alert with no threshold with the route's sentence", async () => {
    const res = await buildApp().request("/", send("POST", { ...input, thresholdPercent: null }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid cost alert");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("map the limit and recipient refusals to 400s", async () => {
    mockCreate.mockRejectedValueOnce(new FakeLimitError("too many alerts"));
    const limit = await buildApp().request("/", send("POST", input));
    expect(limit.status).toBe(400);
    expect(await limit.json()).toEqual({ error: "too many alerts" });

    mockUpdate.mockRejectedValueOnce(new FakeRecipientsError("not a member"));
    const recipients = await buildApp().request("/ca-1", send("PUT", input));
    expect(recipients.status).toBe(400);
    expect(await recipients.json()).toEqual({ error: "not a member" });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("update and delete, 404 when the alert is gone", async () => {
    expect((await buildApp().request("/ca-1", send("PUT", input))).status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("org-1", "ca-1", expect.objectContaining(input));
    const deleted = await buildApp().request("/ca-1", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_alert.delete", entityId: "ca-1" }),
    );

    mockUpdate.mockResolvedValueOnce(null);
    expect((await buildApp().request("/ca-1", send("PUT", input))).status).toBe(404);
    mockDelete.mockResolvedValueOnce(false);
    expect((await buildApp().request("/ca-1", { method: "DELETE" })).status).toBe(404);
  });
});
