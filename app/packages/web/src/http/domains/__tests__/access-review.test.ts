import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const review = {
  principals: [],
  findings: [],
  totalCount: 0,
  dismissed: [],
  dismissedCount: 0,
  staleDays: 30,
  generatedAt: "2026-11-08T10:00:00.000Z",
};
const mockList = vi.fn(async (..._args: unknown[]) => review);
vi.mock("@infrawrench/server-core/access-review/feed", () => ({
  listAccessReview: (...a: unknown[]) => mockList(...a),
}));
const mockDismiss = vi.fn();
const mockRestore = vi.fn();
vi.mock("@infrawrench/server-core/posture/dismissals", () => ({
  MAX_DISMISSAL_REASON_LENGTH: 500,
  dismissPostureFinding: (...a: unknown[]) => mockDismiss(...a),
  restorePostureFinding: (...a: unknown[]) => mockRestore(...a),
}));
const mockAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockAudit(...a) }));

const { accessReviewDomain } = await import("@/http/domains/access-review/index");
const buildApp = () =>
  buildTestApi(accessReviewDomain, { basePath: "/api/org/org-1/access-review" });

beforeEach(() => vi.clearAllMocks());

describe("access review routes", () => {
  it("reads the staleness window and refuses one it cannot use", async () => {
    expect((await buildApp().request("/?staleDays=30")).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("org-1", { staleDays: 30 });
    const bad = await buildApp().request("/?staleDays=abc");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "staleDays must be a number" });
  });

  it("exports CSV as an attachment and audits it", async () => {
    const res = await buildApp().request("/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="access-review-2026-11-08.csv"',
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "access_review.exported" }),
    );
  });

  it("exports pretty-printed JSON", async () => {
    const res = await buildApp().request("/export?format=json");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.text()).toBe(JSON.stringify(review, null, 2));
    const bad = await buildApp().request("/export?format=xml");
    expect(await bad.json()).toEqual({ error: 'format must be "csv" or "json"' });
  });

  it("dismisses with the shared checks and projects the record", async () => {
    mockDismiss.mockResolvedValue({
      id: "d1",
      organizationId: "org-1",
      resourceId: "aws:a:u",
      ruleId: "access-review:no-mfa",
      dismissedAt: "2026-11-08T10:00:00.000Z",
      dismissedBy: "Ada",
      reason: null,
    });
    const res = await buildApp().request("/dismissals", {
      method: "POST",
      body: JSON.stringify({ resourceId: "aws:a:u", ruleId: "access-review:no-mfa" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("organizationId");
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "access_review.finding.dismissed" }),
    );

    const missing = await buildApp().request("/dismissals", {
      method: "POST",
      body: JSON.stringify({ ruleId: "x" }),
    });
    expect(await missing.json()).toEqual({ error: "resourceId is required" });
  });

  it("restores by query, 204, and 404s when nothing was dismissed", async () => {
    mockRestore.mockResolvedValueOnce(true);
    const res = await buildApp().request("/dismissals?resourceId=r&ruleId=x", { method: "DELETE" });
    expect(res.status).toBe(204);
    mockRestore.mockResolvedValueOnce(false);
    const gone = await buildApp().request("/dismissals?resourceId=r&ruleId=x", {
      method: "DELETE",
    });
    expect(gone.status).toBe(404);
    const noKey = await buildApp().request("/dismissals?ruleId=x", { method: "DELETE" });
    expect(await noKey.json()).toEqual({ error: "resourceId is required" });
  });
});
