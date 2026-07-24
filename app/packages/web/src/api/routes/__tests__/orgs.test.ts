import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockInsert = vi.fn();
vi.mock("@/db/client", () => ({
  db: { insert: (...a: unknown[]) => mockInsert(...a) },
}));

const mockEnsureSystemRoles = vi.fn();
const mockGetSystemRole = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  ensureSystemRoles: (...a: unknown[]) => mockEnsureSystemRoles(...a),
  getSystemRole: (...a: unknown[]) => mockGetSystemRole(...a),
}));

vi.mock("uuid", () => ({ v4: () => "org-uuid-1" }));

const { orgManagementRoutes } = await import("@/api/routes/orgs");
const buildApp = () => buildTestApp(orgManagementRoutes);

describe("Org management routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    mockEnsureSystemRoles.mockResolvedValue(undefined);
    mockGetSystemRole.mockResolvedValue({ id: "owner-role-1" });
  });

  it("creates an org, an owner membership, and the default Home dashboard", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "  Acme  " }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "org-uuid-1", displayName: "Acme" });
    // organizations + organizationMembers + default dashboard inserts
    expect(mockInsert).toHaveBeenCalledTimes(3);
    expect(mockEnsureSystemRoles).toHaveBeenCalledWith("org-uuid-1");
    expect(mockGetSystemRole).toHaveBeenCalledWith("org-uuid-1", "owner");
    const insertedValues = mockInsert.mock.results.flatMap((r) =>
      (r.value.values as ReturnType<typeof vi.fn>).mock.calls.flat(),
    );
    expect(insertedValues).toContainEqual({
      id: "org-uuid-1",
      organizationId: "org-uuid-1",
      name: "Home",
      isDefault: true,
    });
  });

  it("rejects a blank name with 400", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "   " }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/required/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects a missing name with 400", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
