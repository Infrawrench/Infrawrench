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

const mockSendTestPush = vi.fn();
vi.mock("@infrawrench/server-core/push/dispatch", () => ({
  sendTestPushToUser: (...a: unknown[]) => mockSendTestPush(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

const { pushDomain } = await import("@/http/domains/push/index");
const buildOrgApp = () => buildTestApi(pushDomain, { basePath: "/api/org/org-1/push" });

describe("push org routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Preferences are a mute list keyed by trigger id, not a column per trigger:
   * adding a trigger to the registry must not need a migration here.
   */
  const putPreferences = (body: unknown) =>
    buildOrgApp().request("/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  describe("GET /preferences", () => {
    it("returns the shipped defaults when no row exists, not an empty list", async () => {
      const where = vi.fn().mockResolvedValue([]);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });
      const body = await (await buildOrgApp().request("/preferences")).json();
      // Drift ships muted: it is a continuous feed rather than an exceptional
      // event. An empty list would tell the phone the opposite.
      expect(body).toEqual({ mutedTriggers: ["savingsFindings", "resourceDrift"] });
    });

    it("returns the stored mutes when a row exists", async () => {
      const where = vi.fn().mockResolvedValue([{ mutedTriggers: ["budgetAlerts"] }]);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });
      const body = await (await buildOrgApp().request("/preferences")).json();
      expect(body).toEqual({ mutedTriggers: ["budgetAlerts"] });
    });
  });

  describe("PUT /preferences", () => {
    function setupUpsert() {
      const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      mockInsert.mockReturnValue({ values });
      return { values, onConflictDoUpdate };
    }

    it("rejects a body that is not a list of triggers", async () => {
      expect((await putPreferences({ syncIncidents: false })).status).toBe(400);
      expect((await putPreferences({ mutedTriggers: "budgetAlerts" })).status).toBe(400);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("rejects unknown trigger names instead of storing them", async () => {
      setupUpsert();
      // Silently keeping a typo would look like it worked while the trigger it
      // was meant to silence kept arriving.
      const res = await putPreferences({ mutedTriggers: ["budgetAlerts", "budgtAlerts"] });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/budgtAlerts/);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("upserts the caller's row and audits", async () => {
      const { values, onConflictDoUpdate } = setupUpsert();
      const res = await putPreferences({ mutedTriggers: ["resourceDrift", "budgetAlerts"] });
      expect(res.status).toBe(200);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          organizationId: "org-1",
          mutedTriggers: ["resourceDrift", "budgetAlerts"],
        }),
      );
      const conflict = onConflictDoUpdate.mock.calls[0]![0] as { set: Record<string, unknown> };
      expect(conflict.set).toMatchObject({ mutedTriggers: ["resourceDrift", "budgetAlerts"] });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "push.preferences.update" }),
      );
    });

    it("accepts an empty list as unmuting everything", async () => {
      const { values } = setupUpsert();
      expect((await putPreferences({ mutedTriggers: [] })).status).toBe(200);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ mutedTriggers: [] }));
    });

    it("de-duplicates repeated triggers", async () => {
      const { values } = setupUpsert();
      const res = await putPreferences({ mutedTriggers: ["budgetAlerts", "budgetAlerts"] });
      expect(res.status).toBe(200);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ mutedTriggers: ["budgetAlerts"] }),
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
