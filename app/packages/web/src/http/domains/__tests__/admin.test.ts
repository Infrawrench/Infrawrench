import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));

const mockFeaturesByOrg = vi.fn(async () => new Map<string, string[]>());
const mockSetFeature = vi.fn();
const mockOrgFeatures = vi.fn();
vi.mock("@infrawrench/server-core/features", () => ({
  featuresByOrg: (...a: unknown[]) => mockFeaturesByOrg(...(a as [])),
  setOrgFeature: (...a: unknown[]) => mockSetFeature(...a),
  orgFeatures: (...a: unknown[]) => mockOrgFeatures(...a),
}));
const mockEnsureCiPrices = vi.fn();
vi.mock("../billing/operations", () => ({
  ensureCiPrices: (...a: unknown[]) => mockEnsureCiPrices(...a),
}));

const { adminDomain } = await import("@/http/domains/admin/index");
const buildApp = () => buildTestApi(adminDomain, { basePath: "/api/admin" });

function listReturns(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const leftJoin = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ leftJoin });
  mockSelect.mockReturnValue({ from });
}

function updateReturns(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set };
}

describe("Admin routes", () => {
  // buildTestApi's session email is test@example.com
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com, Test@Example.com";
  });
  afterEach(() => {
    delete process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"];
  });

  it("403s when the allowlist is unset", async () => {
    delete process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"];
    const res = await buildApp().request("/organizations");
    expect(res.status).toBe(403);
  });

  it("403s users not on the allowlist", async () => {
    process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com";
    const res = await buildApp().request("/organizations");
    expect(res.status).toBe(403);
  });

  it("403s users not on the allowlist on any other path under the prefix", async () => {
    process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com";
    const res = await buildApp().request("/orgs");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("403s before reading the body of a write", async () => {
    process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com";
    const res = await buildApp().request("/organizations/org-1/complimentary", {
      method: "PUT",
      body: "not json",
    });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("lists organizations for allowlisted admins (case-insensitive match)", async () => {
    listReturns([
      {
        id: "org-1",
        displayName: "Acme",
        complimentary: false,
        createdAt: "2026-01-01T00:00:00Z",
        memberCount: 3,
        subscriptionStatus: "active",
      },
    ]);
    const res = await buildApp().request("/organizations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: "org-1", complimentary: false });
  });

  it("grants complimentary access", async () => {
    const { set } = updateReturns([{ id: "org-1", complimentary: true }]);
    const res = await buildApp().request("/organizations/org-1/complimentary", {
      method: "PUT",
      body: JSON.stringify({ complimentary: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "org-1", complimentary: true });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ complimentary: true }));
  });

  it("400s on a malformed body", async () => {
    const res = await buildApp().request("/organizations/org-1/complimentary", {
      method: "PUT",
      body: JSON.stringify({ complimentary: "yes" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("404s for an unknown org", async () => {
    updateReturns([]);
    const res = await buildApp().request("/organizations/nope/complimentary", {
      method: "PUT",
      body: JSON.stringify({ complimentary: false }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  describe("per-org features", () => {
    function orgExists(found: boolean) {
      const limit = vi.fn().mockResolvedValue(found ? [{ id: "org-1" }] : []);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });
    }

    it("turns CI on for an org and adds its prices to the subscription", async () => {
      orgExists(true);
      mockEnsureCiPrices.mockResolvedValue(["price_ci_vcpu"]);
      mockOrgFeatures.mockResolvedValue(["ci"]);
      const res = await buildApp().request("/organizations/org-1/features/ci", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "org-1", features: ["ci"] });
      expect(mockSetFeature).toHaveBeenCalledWith("org-1", "ci", true, "test@example.com");
      expect(mockEnsureCiPrices).toHaveBeenCalledWith("org-1");
    });

    it("still turns CI on when Stripe refuses the prices", async () => {
      orgExists(true);
      mockEnsureCiPrices.mockRejectedValue(new Error("stripe down"));
      mockOrgFeatures.mockResolvedValue(["ci"]);
      const res = await buildApp().request("/organizations/org-1/features/ci", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
    });

    it("turns CI off without touching billing, and refuses unknown features and orgs", async () => {
      orgExists(true);
      mockOrgFeatures.mockResolvedValue([]);
      const off = await buildApp().request("/organizations/org-1/features/ci", {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      });
      expect(off.status).toBe(200);
      expect(mockEnsureCiPrices).not.toHaveBeenCalled();

      const unknown = await buildApp().request("/organizations/org-1/features/teleport", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      expect(unknown.status).toBe(400);

      orgExists(false);
      const missing = await buildApp().request("/organizations/nope/features/ci", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      expect(missing.status).toBe(404);
    });
  });
});
