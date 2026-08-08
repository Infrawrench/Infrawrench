import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildTestApp } from "./test-utils";

const mockListPosture = vi.fn();
vi.mock("@infrawrench/server-core/posture/feed", () => ({
  listPosture: (...a: unknown[]) => mockListPosture(...a),
}));

const mockDismiss = vi.fn();
const mockRestore = vi.fn();
vi.mock("@infrawrench/server-core/posture/dismissals", () => ({
  dismissPostureFinding: (...a: unknown[]) => mockDismiss(...a),
  restorePostureFinding: (...a: unknown[]) => mockRestore(...a),
  MAX_DISMISSAL_REASON_LENGTH: 500,
}));

vi.mock("@infrawrench/server-core/posture/settings", () => ({
  getPostureSettings: vi.fn(),
  updatePostureSettings: vi.fn(),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

const { postureRoutes } = await import("@/api/routes/posture");
const app = () => buildTestApp(postureRoutes as unknown as Hono);
/** A member: can read the Posture screen, deliberately cannot silence it. */
const reader = () => buildTestApp(postureRoutes as unknown as Hono, ["resources:read"]);

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("posture dismissal routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /dismissals", () => {
    it("records the dismissal against the calling user and audits it", async () => {
      mockDismiss.mockResolvedValue({
        // `dismissPostureFinding` resolves to the row, not the wire shape.
        id: "dismissal-1",
        organizationId: "org-1",
        resourceId: "r-1",
        ruleId: "public",
        reason: "static site",
        dismissedBy: "Ada",
        dismissedAt: "2026-08-01T00:00:00.000Z",
      });
      const res = await app().request(
        "/dismissals",
        json({ resourceId: "r-1", ruleId: "public", reason: "static site" }),
      );
      expect(res.status).toBe(200);
      expect(mockDismiss).toHaveBeenCalledWith("org-1", {
        resourceId: "r-1",
        ruleId: "public",
        reason: "static site",
        userId: "user-1",
      });
      // The wire shape only — the record's row id and organizationId are
      // internal and the documented body forbids them.
      expect(await res.json()).toEqual({
        resourceId: "r-1",
        ruleId: "public",
        reason: "static site",
        dismissedBy: "Ada",
        dismissedAt: "2026-08-01T00:00:00.000Z",
      });
      // Silencing a security finding has to leave a trace.
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "posture.finding.dismissed",
          entityId: "r-1",
          metadata: { ruleId: "public", reason: "static site" },
        }),
      );
    });

    it("accepts a dismissal with no note", async () => {
      mockDismiss.mockResolvedValue({ resourceId: "r-1", ruleId: "public", reason: null });
      const res = await app().request("/dismissals", json({ resourceId: "r-1", ruleId: "public" }));
      expect(res.status).toBe(200);
      expect(mockDismiss).toHaveBeenCalledWith("org-1", expect.objectContaining({ reason: null }));
    });

    it("rejects a missing or blank key, and an over-long note", async () => {
      const cases = [
        {},
        { ruleId: "public" },
        { resourceId: "r-1" },
        { resourceId: "   ", ruleId: "public" },
        { resourceId: "r-1", ruleId: "" },
        { resourceId: "r-1", ruleId: "public", reason: 42 },
        { resourceId: "r-1", ruleId: "public", reason: "x".repeat(501) },
      ];
      for (const body of cases) {
        const res = await app().request("/dismissals", json(body));
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(mockDismiss).not.toHaveBeenCalled();
    });

    it("rejects a non-object body", async () => {
      const res = await app().request("/dismissals", json(["r-1"]));
      expect(res.status).toBe(400);
      expect(mockDismiss).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /dismissals", () => {
    it("removes the dismissal identified by the query pair", async () => {
      mockRestore.mockResolvedValue(true);
      // A slash-bearing provider id round-trips as a query parameter, which is
      // the whole reason the key is not in the path.
      const resourceId = "projects/p/zones/z/instances/i";
      const query = new URLSearchParams({ resourceId, ruleId: "no-firewall" });
      const res = await app().request(`/dismissals?${query.toString()}`, { method: "DELETE" });
      expect(res.status).toBe(204);
      expect(mockRestore).toHaveBeenCalledWith("org-1", resourceId, "no-firewall");
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "posture.finding.restored", entityId: resourceId }),
      );
    });

    it("404s when that finding was never dismissed", async () => {
      mockRestore.mockResolvedValue(false);
      const res = await app().request("/dismissals?resourceId=r-1&ruleId=public", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("400s without both halves of the key", async () => {
      for (const query of ["", "?resourceId=r-1", "?ruleId=public"]) {
        const res = await app().request(`/dismissals${query}`, { method: "DELETE" });
        expect(res.status, query).toBe(400);
      }
      expect(mockRestore).not.toHaveBeenCalled();
    });
  });

  // The permission is the point of the feature, not an implementation detail:
  // a member who can read the Posture screen must not be able to silence it.
  it("refuses a caller with resources:read but not resources:write", async () => {
    const post = await reader().request(
      "/dismissals",
      json({ resourceId: "r-1", ruleId: "public" }),
    );
    expect(post.status).toBe(403);

    const del = await reader().request("/dismissals?resourceId=r-1&ruleId=public", {
      method: "DELETE",
    });
    expect(del.status).toBe(403);

    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("still lets that caller read the findings", async () => {
    mockListPosture.mockResolvedValue({ findings: [], totalCount: 0 });
    const res = await reader().request("/");
    expect(res.status).toBe(200);
  });
});
