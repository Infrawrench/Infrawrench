import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildTestApp } from "./test-utils";

const mockList = vi.fn();
vi.mock("@infrawrench/server-core/vulnerabilities/feed", () => ({
  listVulnerabilities: (...a: unknown[]) => mockList(...a),
}));

const mockDismiss = vi.fn();
const mockRestore = vi.fn();
vi.mock("@infrawrench/server-core/vulnerabilities/dismissals", () => ({
  dismissVulnerability: (...a: unknown[]) => mockDismiss(...a),
  restoreVulnerability: (...a: unknown[]) => mockRestore(...a),
  MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH: 500,
}));

const mockGetSettings = vi.fn();
const mockUpdateSettings = vi.fn();
vi.mock("@infrawrench/server-core/vulnerabilities/settings", () => ({
  getVulnerabilitySettings: (...a: unknown[]) => mockGetSettings(...a),
  updateVulnerabilitySettings: (...a: unknown[]) => mockUpdateSettings(...a),
  toVulnerabilitySettingsWire: (r: { enabled: boolean }) => ({ alertsEnabled: r.enabled }),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

const { vulnerabilityRoutes } = await import("@/api/routes/vulnerabilities");
const app = () => buildTestApp(vulnerabilityRoutes as unknown as Hono);
const reader = () => buildTestApp(vulnerabilityRoutes as unknown as Hono, ["resources:read"]);

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("vulnerability routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets a reader list the feed", async () => {
    mockList.mockResolvedValue({ findings: [], totalCount: 0 });
    const res = await reader().request("/");
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });

  it("records a dismissal against the caller, audits it, and returns the wire shape", async () => {
    mockDismiss.mockResolvedValue({
      id: "d1",
      organizationId: "org-1",
      advisoryId: "CVE-2024-1",
      artifactKey: "image:ghcr.io/acme/api",
      reason: "not reachable",
      dismissedBy: "Ada",
      dismissedAt: "2026-10-01T00:00:00.000Z",
    });
    const res = await app().request(
      "/dismissals",
      json("POST", {
        advisoryId: "cve-2024-1",
        artifactKey: "image:ghcr.io/acme/api",
        reason: "not reachable",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockDismiss).toHaveBeenCalledWith("org-1", {
      advisoryId: "cve-2024-1",
      artifactKey: "image:ghcr.io/acme/api",
      reason: "not reachable",
      userId: "user-1",
    });
    expect(await res.json()).toEqual({
      advisoryId: "CVE-2024-1",
      artifactKey: "image:ghcr.io/acme/api",
      dismissedAt: "2026-10-01T00:00:00.000Z",
      dismissedBy: "Ada",
      reason: "not reachable",
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "vulnerability.dismissed" }),
    );
  });

  it("refuses dismissals from a reader", async () => {
    const res = await reader().request(
      "/dismissals",
      json("POST", { advisoryId: "CVE-1", artifactKey: "*" }),
    );
    expect(res.status).toBe(403);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("validates the dismissal body", async () => {
    expect((await app().request("/dismissals", json("POST", { artifactKey: "*" }))).status).toBe(
      400,
    );
    expect(
      (
        await app().request(
          "/dismissals",
          json("POST", { advisoryId: "CVE-1", artifactKey: "*", reason: "x".repeat(501) }),
        )
      ).status,
    ).toBe(400);
  });

  it("restores by query and 404s when nothing was dismissed", async () => {
    mockRestore.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const q = "?advisoryId=CVE-1&artifactKey=image%3Aghcr.io%2Facme%2Fapi";
    expect((await app().request(`/dismissals${q}`, { method: "DELETE" })).status).toBe(204);
    expect(mockRestore).toHaveBeenCalledWith("org-1", "CVE-1", "image:ghcr.io/acme/api");
    expect((await app().request(`/dismissals${q}`, { method: "DELETE" })).status).toBe(404);
  });

  it("validates settings", async () => {
    mockUpdateSettings.mockResolvedValue({ enabled: false });
    expect((await app().request("/settings", json("PUT", { minSeverity: "low" }))).status).toBe(
      400,
    );
    expect((await app().request("/settings", json("PUT", {}))).status).toBe(400);
    const ok = await app().request(
      "/settings",
      json("PUT", { alertsEnabled: false, minSeverity: "high" }),
    );
    expect(ok.status).toBe(200);
    expect(mockUpdateSettings).toHaveBeenCalledWith("org-1", {
      alertsEnabled: false,
      minSeverity: "high",
    });
  });
});
