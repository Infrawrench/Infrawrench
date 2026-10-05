import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@infrawrench/server-core/permissions", async () => {
  const catalog = await import("@infrawrench/server-core/permissions/catalog");
  return { hasPermission: catalog.hasPermission, resolveEffectivePermissions: vi.fn() };
});
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("../workos-api", () => ({ getSessionAuth: vi.fn() }));
vi.mock("../directory-sync", () => ({ applyRolesOnLogin: vi.fn() }));
vi.mock("../settings", () => ({ cachedSsoSettings: vi.fn() }));

const { decideSsoAccess, isSsoSession, ssoSignInPath } = await import("../enforcement");

const settings = {
  enforceSso: true,
  verifiedDomains: ["corp.com"],
  breakGlassUserIds: ["owner-1"],
  workosOrganizationId: "org_wos",
};
const sso = { authMethod: "sso", organizationId: "org_wos", status: "active" };
const password = { authMethod: "password", organizationId: null, status: "active" };

function decide(over: Partial<Parameters<typeof decideSsoAccess>[0]>) {
  return decideSsoAccess({
    settings,
    userId: "u1",
    email: "jane@corp.com",
    isOwner: false,
    elevationPermissions: [],
    session: password,
    ...over,
  });
}

describe("decideSsoAccess", () => {
  it("does nothing when enforcement is off or never set up", () => {
    expect(decide({ settings: null }).allow).toBe(true);
    expect(decide({ settings: { ...settings, enforceSso: false } }).allow).toBe(true);
  });

  it("leaves people outside the verified domains alone", () => {
    expect(decide({ email: "contractor@gmail.com" })).toEqual({
      allow: true,
      reason: "outside_domains",
    });
  });

  it("denies a password session for a verified-domain member", () => {
    expect(decide({})).toEqual({ allow: false, reason: "not_sso" });
  });

  it("denies when the session cannot be found (fails closed)", () => {
    expect(decide({ session: null })).toEqual({ allow: false, reason: "session_unknown" });
  });

  it("allows a session established through this org's connection", () => {
    expect(decide({ session: sso })).toEqual({ allow: true, reason: "sso" });
  });

  it("rejects an SSO session from another WorkOS organization", () => {
    expect(decide({ session: { ...sso, organizationId: "org_other" } }).allow).toBe(false);
  });

  it("rejects a revoked SSO session", () => {
    expect(isSsoSession({ ...sso, status: "revoked" }, "org_wos")).toBe(false);
  });

  it("lets a listed break-glass owner through, but only while they are an owner", () => {
    expect(decide({ userId: "owner-1", isOwner: true })).toMatchObject({
      allow: true,
      reason: "break_glass_owner",
      audit: true,
    });
    expect(decide({ userId: "owner-1", isOwner: false }).allow).toBe(false);
    expect(decide({ userId: "other-owner", isOwner: true }).allow).toBe(false);
  });

  it("lets a live sso:bypass break-glass grant through", () => {
    expect(decide({ elevationPermissions: ["sso:bypass"] })).toMatchObject({
      allow: true,
      reason: "break_glass_grant",
    });
  });

  it("never reads the bypass from anything but elevations", () => {
    // `*` on a role is what every owner holds; the gate is not handed role
    // permissions at all, and an owner who is not listed is denied.
    expect(decide({ isOwner: true, userId: "owner-2" }).allow).toBe(false);
  });

  it("builds a same-origin sign-in path", () => {
    expect(ssoSignInPath("a b")).toBe("/api/auth/sign-in?organization=a%20b");
  });
});
