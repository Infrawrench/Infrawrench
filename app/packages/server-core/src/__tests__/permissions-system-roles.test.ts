import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "../permissions/catalog";
import {
  SYSTEM_ROLE_DEFINITIONS,
  isSystemRoleKey,
  systemRolePermissions,
} from "../permissions/system-roles";

describe("isSystemRoleKey", () => {
  it("accepts the three known keys", () => {
    expect(isSystemRoleKey("owner")).toBe(true);
    expect(isSystemRoleKey("admin")).toBe(true);
    expect(isSystemRoleKey("member")).toBe(true);
  });

  it("rejects unknown / null / undefined", () => {
    expect(isSystemRoleKey("superuser")).toBe(false);
    expect(isSystemRoleKey(null)).toBe(false);
    expect(isSystemRoleKey(undefined)).toBe(false);
    expect(isSystemRoleKey("")).toBe(false);
  });
});

describe("SYSTEM_ROLE_DEFINITIONS", () => {
  it("owner gets the full wildcard", () => {
    expect(SYSTEM_ROLE_DEFINITIONS.owner.permissions).toEqual(["*"]);
  });

  it("admin gets everything except billing:write and org:settings:write", () => {
    const perms = SYSTEM_ROLE_DEFINITIONS.admin.permissions;
    expect(perms).not.toContain("billing:write");
    expect(perms).not.toContain("org:settings:write");
    expect(perms).toContain("accounts:write");
    expect(perms).toEqual(
      ALL_PERMISSIONS.filter((p) => p !== "billing:write" && p !== "org:settings:write"),
    );
  });

  it("member is read-mostly and cannot write accounts or manage team", () => {
    const perms = SYSTEM_ROLE_DEFINITIONS.member.permissions;
    expect(perms).toContain("accounts:read");
    expect(perms).toContain("resources:read");
    expect(perms).toContain("resources:execute");
    expect(perms).toContain("dashboards:write");
    expect(perms).not.toContain("accounts:write");
    expect(perms).not.toContain("team:invite");
    expect(perms).not.toContain("billing:write");
  });

  it("member keeps the workflow access dashboards:write used to imply", () => {
    // Workflows rode on `dashboards:*` until they got their own family.
    // Members could write, run, and approve them, and still can — carving
    // `workflows:approve` out of the default would 403 members who approve
    // today. Custom roles are where the split earns its keep.
    const perms = SYSTEM_ROLE_DEFINITIONS.member.permissions;
    expect(perms).toContain("workflows:read");
    expect(perms).toContain("workflows:write");
    expect(perms).toContain("workflows:approve");
  });

  it("member can use chat", () => {
    // `authenticateChat` enforces these. They were missing from the member
    // list while the endpoint checked membership only, so members could always
    // chat in practice; dropping them here would revoke that for every
    // existing member rather than fixing anything.
    const perms = SYSTEM_ROLE_DEFINITIONS.member.permissions;
    expect(perms).toContain("chat:read");
    expect(perms).toContain("chat:write");
  });

  it("each definition's key matches its map key", () => {
    for (const [k, def] of Object.entries(SYSTEM_ROLE_DEFINITIONS)) {
      expect(def.key).toBe(k);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});

describe("systemRolePermissions", () => {
  it("returns the role's permission set", () => {
    expect(systemRolePermissions("owner")).toEqual(["*"]);
    expect(systemRolePermissions("member")).toBe(SYSTEM_ROLE_DEFINITIONS.member.permissions);
  });

  it("returns null for unknown keys", () => {
    expect(systemRolePermissions("nope")).toBeNull();
    expect(systemRolePermissions(null)).toBeNull();
    expect(systemRolePermissions(undefined)).toBeNull();
  });
});
