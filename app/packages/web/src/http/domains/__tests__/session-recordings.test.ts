import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const store = {
  listSessionRecordings: vi.fn(),
  getSessionRecording: vi.fn(),
  readSessionRecordingCast: vi.fn(),
  getSessionRecordingUsage: vi.fn(),
};
vi.mock("@infrawrench/server-core/ssh-recording/store", () => ({
  listSessionRecordings: (...a: unknown[]) => store.listSessionRecordings(...a),
  getSessionRecording: (...a: unknown[]) => store.getSessionRecording(...a),
  readSessionRecordingCast: (...a: unknown[]) => store.readSessionRecordingCast(...a),
  getSessionRecordingUsage: (...a: unknown[]) => store.getSessionRecordingUsage(...a),
  deleteSessionRecording: vi.fn(),
  sessionRecordingFilename: () => "session.cast",
}));

const settings = { get: vi.fn(), update: vi.fn() };
vi.mock("@infrawrench/server-core/ssh-recording/settings", () => ({
  getSessionRecordingSettings: (...a: unknown[]) => settings.get(...a),
  updateSessionRecordingSettings: (...a: unknown[]) => settings.update(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { sessionRecordingsDomain } = await import("@/http/domains/session-recordings/index");
const buildApp = (permissions?: string[]) =>
  buildTestApi(sessionRecordingsDomain, {
    basePath: "/api/org/org-1/session-recordings",
    ...(permissions ? { permissions } : {}),
  });

const usage = { recordingCount: 0, storedBytes: 0, capturedBytes: 0, oldestStartedAt: null };

describe("Session recording routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /", () => {
    it("passes the filters through", async () => {
      store.listSessionRecordings.mockResolvedValue([]);
      const res = await buildApp().request(
        "/?status=complete&userId=u2&limit=5&since=2026-11-01T00:00:00Z",
      );
      expect(res.status).toBe(200);
      expect(store.listSessionRecordings).toHaveBeenCalledWith("org-1", {
        status: "complete",
        userId: "u2",
        since: new Date("2026-11-01T00:00:00Z"),
        limit: 5,
      });
    });

    it("refuses an unknown status with the route's sentence", async () => {
      const res = await buildApp().request("/?status=live");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "status must be one of: recording, complete, truncated, abandoned",
      });
    });

    it("refuses a malformed instant", async () => {
      const res = await buildApp().request("/?until=yesterday");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "since and until must be ISO-8601 instants" });
    });

    it("ignores a limit that is not a positive number", async () => {
      store.listSessionRecordings.mockResolvedValue([]);
      await buildApp().request("/?limit=-3");
      expect(store.listSessionRecordings).toHaveBeenCalledWith("org-1", {});
    });
  });

  describe("PUT /settings", () => {
    it("refuses a body that is not an object, as zod did", async () => {
      const res = await buildApp().request("/settings", { method: "PUT", body: "nope" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Expected object, received null" });
    });

    it("updates, audit-logs before and after, and returns usage", async () => {
      settings.get.mockResolvedValue({ enabled: false, captureInput: false, retentionDays: 30 });
      settings.update.mockResolvedValue({ enabled: true, captureInput: false, retentionDays: 30 });
      store.getSessionRecordingUsage.mockResolvedValue(usage);
      const res = await buildApp().request("/settings", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        enabled: true,
        captureInput: false,
        retentionDays: 30,
        usage,
      });
      expect(settings.update).toHaveBeenCalledWith("org-1", { enabled: true });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "session_recording.settings.update" }),
      );
    });

    it("needs session-recordings:write", async () => {
      const res = await buildApp(["session-recordings:read"]).request("/settings", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /:recordingId/cast", () => {
    it("serves the asciicast as an attachment and records the viewing", async () => {
      store.getSessionRecording.mockResolvedValue({ host: "h", username: "u", userId: "u2" });
      store.readSessionRecordingCast.mockResolvedValue('{"version":2}\n');
      const res = await buildApp().request("/r1/cast?download=1");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="session.cast"');
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.text()).toBe('{"version":2}\n');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "session_recording.view",
          entityId: "r1",
          metadata: expect.objectContaining({ download: true }),
        }),
      );
    });

    it("404s a recording whose tape is gone", async () => {
      store.getSessionRecording.mockResolvedValue({ host: "h", username: "u", userId: "u2" });
      store.readSessionRecordingCast.mockResolvedValue(null);
      const res = await buildApp().request("/r1/cast");
      expect(res.status).toBe(404);
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  });
});
