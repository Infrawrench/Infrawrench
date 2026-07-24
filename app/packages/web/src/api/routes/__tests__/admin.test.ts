import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));

const { adminRoutes } = await import("@/api/routes/admin");
const buildApp = () => buildTestApp(adminRoutes);

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
  // buildTestApp's session email is test@example.com
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
});
