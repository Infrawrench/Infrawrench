import { SYSTEM_ROLE_DEFINITIONS } from "@infrawrench/server-core/permissions/system-roles";
import { describe, expect, it } from "vitest";
import { accessFromPermissions } from "../../auth/access";
import {
  type GrantFacts,
  effectivePermissions,
  isGrantLive,
  rolePermissions,
} from "../org-permissions";

const NOW = new Date("2026-11-25T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const grant = (overrides: Partial<GrantFacts> = {}): GrantFacts => ({
  status: "approved",
  revokedAt: null,
  grantedAt: at(-10),
  grantExpiresAt: at(50),
  permissions: ["git:admin"],
  ...overrides,
});

const systemRole = (systemKey: string) => ({ isSystem: true, systemKey, permissions: [] });
const member = { roleId: "role_1", legacyRole: "member" };

describe("role permissions", () => {
  it("reads a system role from code, ignoring what the row stores", () => {
    expect(
      rolePermissions({ isSystem: true, systemKey: "owner", permissions: ["nothing"] }),
    ).toEqual(["*"]);
    expect(rolePermissions(systemRole("member"))).toBe(SYSTEM_ROLE_DEFINITIONS.member.permissions);
  });

  it("reads a custom role's stored list verbatim", () => {
    expect(
      rolePermissions({ isSystem: false, systemKey: null, permissions: ["git:read", "ci:read"] }),
    ).toEqual(["git:read", "ci:read"]);
    expect(rolePermissions({ isSystem: false, systemKey: null, permissions: null })).toEqual([]);
    // A row marked system with a key code does not know is its stored list, as in the app.
    expect(
      rolePermissions({ isSystem: true, systemKey: "bogus", permissions: ["git:read"] }),
    ).toEqual(["git:read"]);
  });
});

describe("the system roles' Git defaults", () => {
  it("lets members read and push, and admins and owners administer", () => {
    expect(accessFromPermissions(rolePermissions(systemRole("member")))).toBe("write");
    expect(accessFromPermissions(rolePermissions(systemRole("admin")))).toBe("admin");
    expect(accessFromPermissions(rolePermissions(systemRole("owner")))).toBe("admin");
  });
});

describe("effective permissions", () => {
  it("gives a non-member nothing, grant or not", () => {
    expect(effectivePermissions(null, null, [grant()], NOW)).toEqual([]);
    expect(effectivePermissions(null, systemRole("owner"), [], NOW)).toEqual([]);
  });

  it("falls back to the legacy role when the role row is missing", () => {
    expect(effectivePermissions({ roleId: null, legacyRole: "owner" }, null, [], NOW)).toEqual([
      "*",
    ]);
    expect(effectivePermissions({ roleId: "gone", legacyRole: "custom" }, null, [], NOW)).toEqual(
      [],
    );
  });

  it("adds a live grant to the role, without repeating what the role holds", () => {
    const role = { isSystem: false, systemKey: null, permissions: ["git:read"] };
    expect(
      effectivePermissions(member, role, [grant({ permissions: ["git:read", "git:admin"] })], NOW),
    ).toEqual(["git:read", "git:admin"]);
    expect(effectivePermissions(member, role, [], NOW)).toEqual(["git:read"]);
  });

  it("ignores grants that are not live", () => {
    const role = { isSystem: false, systemKey: null, permissions: ["git:read"] };
    const dead = [
      grant({ status: "pending" }),
      grant({ status: "denied" }),
      grant({ revokedAt: at(-1) }),
      grant({ grantExpiresAt: at(-1) }),
      grant({ grantExpiresAt: NOW }),
      grant({ grantedAt: at(1) }),
      grant({ grantedAt: null }),
      grant({ grantExpiresAt: null }),
    ];
    for (const one of dead) expect(isGrantLive(one, NOW.getTime())).toBe(false);
    expect(effectivePermissions(member, role, dead, NOW)).toEqual(["git:read"]);
    expect(isGrantLive(grant({ grantedAt: NOW }), NOW.getTime())).toBe(true);
  });
});
