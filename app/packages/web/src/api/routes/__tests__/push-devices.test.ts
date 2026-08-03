import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));

const mockSendTestPush = vi.fn();
vi.mock("@infrawrench/server-core/push/dispatch", () => ({
  sendTestPushToUser: (...a: unknown[]) => mockSendTestPush(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

const { pushDeviceRoutes, pushOrgRoutes } = await import("@/api/routes/push-devices");
const buildDeviceApp = () => buildTestApp(pushDeviceRoutes as unknown as Hono);
const buildOrgApp = () => buildTestApp(pushOrgRoutes as unknown as Hono);

function setupDeviceUpsert() {
  const returning = vi.fn().mockResolvedValue([{ id: "dev-1" }]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  mockInsert.mockReturnValue({ values });
  return { values, onConflictDoUpdate };
}

describe("push device routes (user-level)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /devices", () => {
    it("rejects a malformed token", async () => {
      const res = await buildDeviceApp().request("/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expoPushToken: "not-a-token", platform: "ios" }),
      });
      expect(res.status).toBe(400);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("rejects an unknown platform", async () => {
      const res = await buildDeviceApp().request("/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expoPushToken: "ExponentPushToken[abc]", platform: "web" }),
      });
      expect(res.status).toBe(400);
    });

    it("upserts on the token and reassigns to the calling user", async () => {
      const { values, onConflictDoUpdate } = setupDeviceUpsert();
      const res = await buildDeviceApp().request("/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expoPushToken: "ExponentPushToken[abc]",
          platform: "ios",
          deviceName: "Astrid's iPhone",
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "dev-1" });
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          expoPushToken: "ExponentPushToken[abc]",
          platform: "ios",
          deviceName: "Astrid's iPhone",
        }),
      );
      // Conflict path revives disabled devices and reassigns ownership.
      const conflictSet = onConflictDoUpdate.mock.calls[0]![0] as { set: Record<string, unknown> };
      expect(conflictSet.set).toMatchObject({
        userId: "user-1",
        failureCount: 0,
        disabledAt: null,
      });
    });

    it("accepts the legacy ExpoPushToken prefix", async () => {
      setupDeviceUpsert();
      const res = await buildDeviceApp().request("/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expoPushToken: "ExpoPushToken[xyz]", platform: "android" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /devices", () => {
    it("lists only the caller's devices without echoing tokens", async () => {
      const orderBy = vi.fn().mockResolvedValue([
        {
          id: "dev-1",
          platform: "ios",
          deviceName: "Phone",
          lastSeenAt: new Date("2026-07-01T00:00:00Z"),
          disabledAt: null,
          expoPushToken: "ExponentPushToken[secret]",
        },
      ]);
      const where = vi.fn().mockReturnValue({ orderBy });
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const res = await buildDeviceApp().request("/devices");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([
        {
          id: "dev-1",
          platform: "ios",
          deviceName: "Phone",
          lastSeenAt: "2026-07-01T00:00:00.000Z",
          disabled: false,
        },
      ]);
      expect(JSON.stringify(body)).not.toContain("ExponentPushToken");
    });
  });

  describe("DELETE /devices/:id", () => {
    it("deletes an owned device", async () => {
      const returning = vi.fn().mockResolvedValue([{ id: "dev-1" }]);
      const where = vi.fn().mockReturnValue({ returning });
      mockDelete.mockReturnValue({ where });
      const res = await buildDeviceApp().request("/devices/dev-1", { method: "DELETE" });
      expect(res.status).toBe(200);
    });

    it("404s when the device is missing or owned by someone else", async () => {
      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      mockDelete.mockReturnValue({ where });
      const res = await buildDeviceApp().request("/devices/other", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});

describe("push org routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /preferences", () => {
    // Everything defaults on except resource drift, which is a continuous
    // feed rather than an exceptional event — see server-core db/schema.ts.
    it("defaults to all-enabled-but-drift when no row exists", async () => {
      const where = vi.fn().mockResolvedValue([]);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });
      const body = await (await buildOrgApp().request("/preferences")).json();
      expect(body).toEqual({
        syncIncidents: true,
        budgetAlerts: true,
        anomalyAlerts: true,
        resourceDrift: false,
        workflowPages: true,
        providerIncidents: true,
        expiryAlerts: true,
        logMatchAlerts: true,
      });
    });
  });

  describe("PUT /preferences", () => {
    it("rejects non-boolean values", async () => {
      const res = await buildOrgApp().request("/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncIncidents: "yes" }),
      });
      expect(res.status).toBe(400);
    });

    it("upserts the caller's row and audits", async () => {
      const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      mockInsert.mockReturnValue({ values });
      const res = await buildOrgApp().request("/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncIncidents: false }),
      });
      expect(res.status).toBe(200);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1", organizationId: "org-1" }),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "push.preferences.update" }),
      );
    });
  });

  describe("POST /test", () => {
    it("returns the delivery summary", async () => {
      mockSendTestPush.mockResolvedValue({ attempted: 1, succeeded: 1 });
      const res = await buildOrgApp().request("/test", { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, attempted: 1, succeeded: 1 });
      expect(mockSendTestPush).toHaveBeenCalledWith("user-1", "org-1");
    });

    it("surfaces failures as 400", async () => {
      mockSendTestPush.mockRejectedValue(new Error("No registered devices"));
      const res = await buildOrgApp().request("/test", { method: "POST" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/No registered devices/);
    });
  });
});
