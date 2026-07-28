import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));
vi.mock("@/db/schema", () => ({
  users: {},
  apiKeys: { id: "id", userId: "uid", organizationId: "org", revokedAt: "revoked_at" },
  invitations: { id: "id", organizationId: "org", acceptedAt: "accepted", roleId: "role_id" },
  organizationMembers: {
    userId: "uid",
    organizationId: "org",
    role: "role",
    roleId: "role_id",
  },
  roles: { id: "id", organizationId: "org", systemKey: "system_key" },
}));

vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/services/seat-release", () => ({ releaseSeat: vi.fn().mockResolvedValue(undefined) }));

const mockHasPermission = vi.fn().mockReturnValue(true);
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({
  hasPermission: (...a: unknown[]) => mockHasPermission(...a),
}));

vi.mock("@infrawrench/server-core/permissions", () => ({
  ALL_PERMISSIONS: ["team:read", "team:invite", "billing:write"],
  ensureSystemRoles: vi.fn().mockResolvedValue(undefined),
  getSystemRole: vi.fn().mockResolvedValue({ id: "sys-owner", permissions: ["*"] }),
  isSubsetOfCallerPerms: vi.fn().mockReturnValue(true),
  isSystemRoleKey: (k: unknown) => k === "owner" || k === "admin" || k === "member",
  systemRolePermissions: (k: string) => (k === "owner" ? ["*"] : ["team:read"]),
}));

const { teamRoutes } = await import("@/api/routes/team");
const { releaseSeat } = await import("@/services/seat-release");
const perms = await import("@infrawrench/server-core/permissions");

function buildApp(opts?: { permissions?: string[]; roleSystemKey?: string | null }) {
  const app = new Hono();
  const session: AuthSession = { userId: "user-1", email: "test@example.com" };
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    c.set("permissions", opts?.permissions ?? ["*"]);
    c.set(
      "role",
      opts?.roleSystemKey === undefined
        ? null
        : ({ id: "r", name: "R", systemKey: opts.roleSystemKey } as never),
    );
    return next();
  });
  app.route("/", teamRoutes);
  return app;
}

describe("Team routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPermission.mockReturnValue(true);
    vi.mocked(perms.isSubsetOfCallerPerms).mockReturnValue(true);
    vi.mocked(perms.ensureSystemRoles).mockResolvedValue(undefined);
    vi.mocked(perms.getSystemRole).mockResolvedValue({
      id: "sys-owner",
      permissions: ["*"],
    } as never);
  });

  it("GET /me returns session, role and permissions", async () => {
    const res = await buildApp({ roleSystemKey: "admin" }).request("/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("user-1");
    expect(body.role.systemKey).toBe("admin");
    expect(body.permissions).toEqual(["*"]);
  });

  it("GET /permissions returns the catalog", async () => {
    const res = await buildApp().request("/permissions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissions).toContain("team:read");
  });

  it("GET /permissions is 403 without team:read", async () => {
    mockHasPermission.mockReturnValue(false);
    const res = await buildApp({ permissions: [] }).request("/permissions");
    expect(res.status).toBe(403);
  });

  it("GET /roles lists serialized roles", async () => {
    const where = vi.fn().mockResolvedValue([
      {
        id: "r1",
        name: "Owner",
        description: null,
        isSystem: true,
        systemKey: "owner",
        permissions: null,
      },
      {
        id: "r2",
        name: "Custom",
        description: "d",
        isSystem: false,
        systemKey: null,
        permissions: ["team:read"],
      },
    ]);
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });

    const res = await buildApp().request("/roles");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].permissions).toEqual(["*"]); // system owner expanded
    expect(body[1].permissions).toEqual(["team:read"]);
  });

  it("POST /roles rejects empty name", async () => {
    const res = await buildApp().request("/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  ", permissions: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /roles blocks privilege escalation", async () => {
    vi.mocked(perms.isSubsetOfCallerPerms).mockReturnValue(false);
    const res = await buildApp().request("/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Esc", permissions: ["billing:write"] }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /roles creates a role and returns it", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    const where = vi.fn().mockResolvedValue([
      {
        id: "new",
        name: "Custom",
        description: null,
        isSystem: false,
        systemKey: null,
        permissions: ["team:read"],
      },
    ]);
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });

    const res = await buildApp().request("/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Custom", permissions: ["team:read"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Custom");
    expect(values).toHaveBeenCalled();
  });

  it("PATCH /roles/:id 404 when not found", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });
    const res = await buildApp().request("/roles/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /roles/:id 422 for system roles", async () => {
    const limit = vi.fn().mockResolvedValue([{ id: "x", isSystem: true, systemKey: "owner" }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });
    const res = await buildApp().request("/roles/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n" }),
    });
    expect(res.status).toBe(422);
  });

  it("DELETE /roles/:id rejects when assigned to a member (409)", async () => {
    // first select: existing role
    const limit = vi.fn().mockResolvedValue([{ id: "x", isSystem: false, systemKey: null }]);
    const firstWhere = vi.fn().mockReturnValue({ limit });
    const firstFrom = vi.fn().mockReturnValue({ where: firstWhere });
    // second select: member count
    const memberWhere = vi.fn().mockResolvedValue([{ n: 2 }]);
    const memberFrom = vi.fn().mockReturnValue({ where: memberWhere });
    mockSelect.mockReturnValueOnce({ from: firstFrom }).mockReturnValueOnce({ from: memberFrom });

    const res = await buildApp().request("/roles/x", { method: "DELETE" });
    expect(res.status).toBe(409);
  });

  it("GET /members joins users and roles", async () => {
    const where = vi.fn().mockResolvedValue([{ id: "u1", email: "a@b.c", role: "owner" }]);
    const leftJoin = vi.fn().mockReturnValue({ where });
    const innerJoin = vi.fn().mockReturnValue({ leftJoin });
    const from = vi.fn().mockReturnValue({ innerJoin });
    mockSelect.mockReturnValue({ from });
    const res = await buildApp().request("/members");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].email).toBe("a@b.c");
  });

  it("POST /invitations creates an invite and returns a token", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    const res = await buildApp().request("/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@e.com", role: "member" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.id).toBeTruthy();
  });

  it("DELETE /members/:id blocks removing the last owner", async () => {
    // isMemberOwner -> owner
    const ownerLimit = vi.fn().mockResolvedValue([{ legacyRole: "owner", systemKey: "owner" }]);
    const ownerWhere = vi.fn().mockReturnValue({ limit: ownerLimit });
    const ownerLeftJoin = vi.fn().mockReturnValue({ where: ownerWhere });
    const ownerFrom = vi.fn().mockReturnValue({ leftJoin: ownerLeftJoin });
    // countOwners -> single owner
    const countWhere = vi.fn().mockResolvedValue([{ legacyRole: "owner", systemKey: "owner" }]);
    const countLeftJoin = vi.fn().mockReturnValue({ where: countWhere });
    const countFrom = vi.fn().mockReturnValue({ leftJoin: countLeftJoin });
    mockSelect.mockReturnValueOnce({ from: ownerFrom }).mockReturnValueOnce({ from: countFrom });

    const res = await buildApp({ roleSystemKey: "owner" }).request("/members/u2", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /members/:id forbids non-owner removing an owner", async () => {
    const ownerLimit = vi.fn().mockResolvedValue([{ legacyRole: "owner", systemKey: "owner" }]);
    const ownerWhere = vi.fn().mockReturnValue({ limit: ownerLimit });
    const ownerLeftJoin = vi.fn().mockReturnValue({ where: ownerWhere });
    const ownerFrom = vi.fn().mockReturnValue({ leftJoin: ownerLeftJoin });
    mockSelect.mockReturnValue({ from: ownerFrom });

    const res = await buildApp({ roleSystemKey: "admin" }).request("/members/u2", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /members/:id removes the member and releases their seat", async () => {
    // isMemberOwner -> not an owner
    const ownerLimit = vi.fn().mockResolvedValue([]);
    const ownerWhere = vi.fn().mockReturnValue({ limit: ownerLimit });
    const ownerLeftJoin = vi.fn().mockReturnValue({ where: ownerWhere });
    const ownerFrom = vi.fn().mockReturnValue({ leftJoin: ownerLeftJoin });
    mockSelect.mockReturnValue({ from: ownerFrom });
    mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    // apiKeys revocation
    const returning = vi.fn().mockResolvedValue([]);
    const revokeWhere = vi.fn().mockReturnValue({ returning });
    mockUpdate.mockReturnValue({ set: vi.fn().mockReturnValue({ where: revokeWhere }) });

    const res = await buildApp({ roleSystemKey: "owner" }).request("/members/u2", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(releaseSeat).toHaveBeenCalledWith("org-1");
  });

  it("DELETE /members/:id still succeeds when the seat release fails", async () => {
    const ownerLimit = vi.fn().mockResolvedValue([]);
    const ownerWhere = vi.fn().mockReturnValue({ limit: ownerLimit });
    const ownerLeftJoin = vi.fn().mockReturnValue({ where: ownerWhere });
    const ownerFrom = vi.fn().mockReturnValue({ leftJoin: ownerLeftJoin });
    mockSelect.mockReturnValue({ from: ownerFrom });
    mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const returning = vi.fn().mockResolvedValue([]);
    const revokeWhere = vi.fn().mockReturnValue({ returning });
    mockUpdate.mockReturnValue({ set: vi.fn().mockReturnValue({ where: revokeWhere }) });
    vi.mocked(releaseSeat).mockRejectedValueOnce(new Error("stripe down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await buildApp({ roleSystemKey: "owner" }).request("/members/u2", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    errorSpy.mockRestore();
  });

  it("DELETE /invitations/:id returns ok", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    mockDelete.mockReturnValue({ where });
    const res = await buildApp().request("/invitations/inv1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
