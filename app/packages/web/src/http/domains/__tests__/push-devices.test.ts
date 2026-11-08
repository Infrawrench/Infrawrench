import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

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

const { pushDevicesDomain } = await import("@/http/domains/push-devices/index");
const buildDeviceApp = () => buildTestApi(pushDevicesDomain, { basePath: "/api/push" });

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
