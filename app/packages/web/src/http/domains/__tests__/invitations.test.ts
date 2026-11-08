import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

/** Rows the next `select(...)` chains resolve to, in order. */
const selectQueue: unknown[][] = [];
const chain = () => {
  const rows = selectQueue.shift() ?? [];
  const node = {
    from: () => node,
    innerJoin: () => node,
    where: () => node,
    limit: () => Promise.resolve(rows),
  };
  return node;
};
const mockInsertValues = vi.fn();
const mockUpdateSet = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: () => chain(),
    insert: () => ({
      values: (v: unknown) => (
        mockInsertValues(v),
        { onConflictDoNothing: () => Promise.resolve() }
      ),
    }),
    update: () => ({
      set: (v: unknown) => (mockUpdateSet(v), { where: () => Promise.resolve() }),
    }),
  },
}));

const mockGetUser = vi.fn();
vi.mock("@/auth/workos", () => ({
  workos: { userManagement: { getUser: (...a: unknown[]) => mockGetUser(...a) } },
  clientId: "client-1",
}));

const mockGetSystemRole = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  ensureSystemRoles: vi.fn(async () => undefined),
  getSystemRole: (...a: unknown[]) => mockGetSystemRole(...a),
  isSystemRoleKey: (k: string) => ["owner", "admin", "member"].includes(k),
}));

const { invitationsDomain } = await import("@/http/domains/invitations/index");
const buildApp = () => buildTestApi(invitationsDomain, { basePath: "/api/invitations" });

const accept = (body: unknown) =>
  buildApp().request("/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const INVITE = {
  id: "inv-1",
  email: "test@example.com",
  role: "admin",
  roleId: null,
  organizationId: "org-9",
};

describe("invitation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    mockGetUser.mockResolvedValue({ emailVerified: true });
    mockGetSystemRole.mockResolvedValue({ id: "role-admin" });
  });

  it("404s an unknown, accepted or expired token", async () => {
    selectQueue.push([]);
    const res = await buildApp().request("/by-token/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Invitation not found" });
  });

  it("describes a pending invitation", async () => {
    selectQueue.push([
      {
        id: "inv-1",
        email: "test@example.com",
        role: "member",
        expiresAt: new Date("2026-12-01T00:00:00Z"),
        acceptedAt: null,
        orgId: "org-9",
        orgName: "Acme",
      },
    ]);
    const res = await buildApp().request("/by-token/tok");
    expect(await res.json()).toEqual({
      id: "inv-1",
      email: "test@example.com",
      role: "member",
      expiresAt: "2026-12-01T00:00:00.000Z",
      acceptedAt: null,
      organizationId: "org-9",
      organizationName: "Acme",
    });
  });

  it("refuses an invalid or expired invitation", async () => {
    selectQueue.push([]);
    const res = await accept({ token: "tok" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid or expired invitation" });
  });

  it("refuses an invitation sent to someone else", async () => {
    selectQueue.push([{ ...INVITE, email: "other@example.com" }]);
    const res = await accept({ token: "tok" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "This invitation was sent to a different email address",
    });
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("refuses an unverified email", async () => {
    selectQueue.push([INVITE]);
    mockGetUser.mockResolvedValue({ emailVerified: false });
    const res = await accept({ token: "tok" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Email address must be verified before accepting invitations",
    });
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("fails closed when WorkOS cannot say", async () => {
    selectQueue.push([INVITE]);
    mockGetUser.mockRejectedValue(new Error("down"));
    const res = await accept({ token: "tok" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Unable to verify account status" });
  });

  it("binds the membership under the invitation's role and marks it accepted", async () => {
    selectQueue.push([INVITE], [{ id: "org-9", displayName: "Acme" }]);
    const res = await accept({ token: "tok" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organization: { id: "org-9", displayName: "Acme" } });
    expect(mockGetSystemRole).toHaveBeenCalledWith("org-9", "admin");
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        organizationId: "org-9",
        role: "admin",
        roleId: "role-admin",
      }),
    );
    expect(mockUpdateSet).toHaveBeenCalledWith({ acceptedAt: expect.any(Date) });
  });

  it("is a 500, as before, for a body without a string token", async () => {
    const res = await accept({ token: 5 });
    expect(res.status).toBe(500);
  });
});
