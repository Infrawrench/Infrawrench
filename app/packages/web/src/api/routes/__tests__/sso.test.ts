import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * SSO route tests. The happy paths are thin wrappers over WorkOS; what is
 * pinned here is every way the routes could be used to get *in*:
 *
 *  - the permission split (reading is `team:read`, every change is
 *    `org:settings:write`),
 *  - a group mapping can never target the owner role, nor a role holding
 *    permissions the caller lacks,
 *  - only owners can be break-glass accounts,
 *  - enforcement cannot be switched on by a session it would immediately
 *    lock out, nor without a break-glass owner.
 */

/** Drizzle-shaped chain: every method returns the chain, awaiting it yields the next queued result. */
const selectResults: unknown[][] = [];
function chain(): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          const result = selectResults.shift() ?? [];
          return (resolve: (v: unknown) => void) => resolve(result);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}
vi.mock("@/db/client", () => ({
  db: {
    select: () => chain(),
    insert: () => chain(),
    update: () => chain(),
    delete: () => chain(),
  },
}));

vi.mock("@infrawrench/server-core/permissions", async () => ({
  ...(await vi.importActual<object>("@infrawrench/server-core/permissions/catalog")),
  isSystemRoleKey: (k: unknown) => k === "owner" || k === "admin" || k === "member",
  systemRolePermissions: (k: string) => (k === "owner" ? ["*"] : ["team:read"]),
}));

const mockLoadSettings = vi.fn();
const mockUpdateSettings = vi.fn();
vi.mock("@/services/sso/settings", () => ({
  loadSsoSettings: (...a: unknown[]) => mockLoadSettings(...a),
  updateSsoSettings: (...a: unknown[]) => mockUpdateSettings(...a),
}));
const mockSessionState = vi.fn();
vi.mock("@/services/sso/enforcement", () => ({
  currentSessionState: (...a: unknown[]) => mockSessionState(...a),
}));
vi.mock("@/services/sso/directory-sync", () => ({
  loadMappings: vi.fn().mockResolvedValue([]),
  previewMappings: vi.fn().mockResolvedValue([]),
  reconcileDirectories: vi.fn(),
}));
const wos = {
  listDomains: vi.fn(),
  listConnections: vi.fn(),
  listDirectories: vi.fn(),
  listDirectoryGroups: vi.fn(),
  createWorkosOrganization: vi.fn(),
  generatePortalLink: vi.fn(),
};
vi.mock("@/services/sso/workos-api", () => wos);
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/services/entitlements", () => ({
  planAccess: vi.fn().mockResolvedValue({ paid: true, reason: "subscription" }),
}));

const { ssoRoutes } = await import("@/api/routes/sso");

const settingsRow = {
  organizationId: "org-1",
  workosOrganizationId: "org_wos",
  enforceSso: false,
  verifiedDomains: ["corp.com"],
  breakGlassUserIds: [] as string[],
  provisioningEnabled: false,
  defaultRoleId: null,
  autoAddSeats: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  updatedByUserId: null,
};

function app(permissions: string[] = ["*"]) {
  const a = new Hono();
  a.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });
  a.use("*", async (c, next) => {
    c.set("session", { userId: "user-1", email: "jane@corp.com", sessionId: "session_1" });
    c.set("organizationId", "org-1");
    c.set("permissions", permissions);
    c.set("role", null);
    return next();
  });
  a.route("/", ssoRoutes);
  return a;
}

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

describe("SSO routes", () => {
  beforeEach(() => {
    selectResults.length = 0;
    mockLoadSettings.mockResolvedValue({ ...settingsRow });
    mockUpdateSettings.mockImplementation(async (_o: string, patch: object) => ({
      ...settingsRow,
      ...patch,
    }));
    wos.listDomains.mockResolvedValue([
      { id: "d1", domain: "corp.com", state: "verified", verificationStrategy: "dns" },
    ]);
    wos.listConnections.mockResolvedValue([
      { id: "c1", name: "Okta", type: "OktaSAML", state: "active" },
    ]);
    wos.listDirectories.mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it("reading needs team:read", async () => {
    expect((await app([]).request("/")).status).toBe(403);
  });

  it("every change needs org:settings:write", async () => {
    const a = app(["team:read"]);
    expect((await a.request("/setup", { method: "POST" })).status).toBe(403);
    expect((await a.request("/settings", { method: "PUT", ...json({}) })).status).toBe(403);
    expect((await a.request("/group-mappings", { method: "POST", ...json({}) })).status).toBe(403);
    expect((await a.request("/sync", { method: "POST" })).status).toBe(403);
    expect(
      (await a.request("/portal-link", { method: "POST", ...json({ intent: "sso" }) })).status,
    ).toBe(403);
  });

  it("refuses a group mapping that targets the owner role", async () => {
    selectResults.push([
      { id: "r-owner", name: "Owner", isSystem: true, systemKey: "owner", permissions: [] },
    ]);
    const res = await app().request("/group-mappings", {
      method: "POST",
      ...json({ directoryGroupId: "directory_group_1", roleId: "r-owner" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/owner role/);
  });

  it("refuses a group mapping to a role holding permissions the caller lacks", async () => {
    selectResults.push([
      {
        id: "r-custom",
        name: "Billing",
        isSystem: false,
        systemKey: null,
        permissions: ["billing:write"],
      },
    ]);
    const res = await app(["org:settings:write", "team:read"]).request("/group-mappings", {
      method: "POST",
      ...json({ directoryGroupId: "directory_group_1", roleId: "r-custom" }),
    });
    expect(res.status).toBe(403);
  });

  it("only owners can be break-glass accounts", async () => {
    // listOwners: one owner row, user-1.
    selectResults.push([
      {
        userId: "user-1",
        legacyRole: "owner",
        systemKey: "owner",
        email: "a@x",
        displayName: null,
      },
    ]);
    const res = await app().request("/settings", {
      method: "PUT",
      ...json({ breakGlassUserIds: ["user-2"] }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses to require SSO without a break-glass owner", async () => {
    mockSessionState.mockResolvedValue("sso");
    const res = await app().request("/settings", { method: "PUT", ...json({ enforceSso: true }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/break-glass/);
  });

  it("refuses to require SSO from a session it would lock out", async () => {
    mockLoadSettings.mockResolvedValue({ ...settingsRow, breakGlassUserIds: ["owner-9"] });
    mockSessionState.mockResolvedValue("not_sso");
    const res = await app().request("/settings", { method: "PUT", ...json({ enforceSso: true }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sign you out/);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it("refuses to require SSO with no active connection", async () => {
    mockLoadSettings.mockResolvedValue({ ...settingsRow, breakGlassUserIds: ["owner-9"] });
    wos.listConnections.mockResolvedValue([
      { id: "c1", name: "Okta", type: "OktaSAML", state: "draft" },
    ]);
    const res = await app().request("/settings", { method: "PUT", ...json({ enforceSso: true }) });
    expect(res.status).toBe(400);
  });

  it("requires SSO when every way back in exists", async () => {
    mockLoadSettings.mockResolvedValue({ ...settingsRow, breakGlassUserIds: ["owner-9"] });
    mockSessionState.mockResolvedValue("sso");
    const res = await app().request("/settings", { method: "PUT", ...json({ enforceSso: true }) });
    expect(res.status).toBe(200);
    expect((await res.json()).enforceSso).toBe(true);
  });

  it("answers 409 for directory routes before setup", async () => {
    mockLoadSettings.mockResolvedValue(null);
    expect((await app().request("/groups")).status).toBe(409);
  });
});
