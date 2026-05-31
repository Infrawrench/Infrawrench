import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, hasPermission, isSubsetOfCallerPerms } from "../permissions/catalog";

describe("hasPermission", () => {
  it("returns false for empty granted lists", () => {
    expect(hasPermission([], "accounts:read")).toBe(false);
    expect(hasPermission(undefined as unknown as string[], "accounts:read")).toBe(false);
  });

  it("matches an exact permission", () => {
    expect(hasPermission(["accounts:read"], "accounts:read")).toBe(true);
    expect(hasPermission(["accounts:read"], "accounts:write")).toBe(false);
  });

  it("a bare * matches everything", () => {
    expect(hasPermission(["*"], "accounts:read")).toBe(true);
    expect(hasPermission(["*"], "team:role:write")).toBe(true);
  });

  it("matches a segment wildcard of the same arity", () => {
    expect(hasPermission(["accounts:*"], "accounts:read")).toBe(true);
    expect(hasPermission(["accounts:*"], "accounts:write")).toBe(true);
    expect(hasPermission(["team:*"], "team:role:write")).toBe(false); // arity mismatch
    expect(hasPermission(["team:*:*"], "team:role:write")).toBe(true);
  });

  it("requires matching segment count", () => {
    expect(hasPermission(["accounts"], "accounts:read")).toBe(false);
    expect(hasPermission(["accounts:read:extra"], "accounts:read")).toBe(false);
  });

  it("scans across multiple granted entries", () => {
    expect(hasPermission(["foo:bar", "accounts:read"], "accounts:read")).toBe(true);
  });
});

describe("isSubsetOfCallerPerms", () => {
  it("empty target is always a subset", () => {
    expect(isSubsetOfCallerPerms([], ["accounts:read"])).toBe(true);
    expect(isSubsetOfCallerPerms(undefined as unknown as string[], [])).toBe(true);
  });

  it("caller with full wildcard covers anything", () => {
    expect(isSubsetOfCallerPerms(["*"], ["*"])).toBe(true);
    expect(isSubsetOfCallerPerms(["accounts:read", "billing:write"], ["*"])).toBe(true);
  });

  it("target * requires caller to hold every catalog permission", () => {
    expect(isSubsetOfCallerPerms(["*"], ["accounts:read"])).toBe(false);
    expect(isSubsetOfCallerPerms(["*"], [...ALL_PERMISSIONS])).toBe(true);
  });

  it("expands a wildcard target against the catalog", () => {
    // accounts:* expands to accounts:read/write/delete.
    expect(isSubsetOfCallerPerms(["accounts:*"], ["accounts:read"])).toBe(false);
    expect(
      isSubsetOfCallerPerms(["accounts:*"], ["accounts:read", "accounts:write", "accounts:delete"]),
    ).toBe(true);
  });

  it("non-wildcard unknown entries pass through as themselves", () => {
    expect(isSubsetOfCallerPerms(["custom:thing"], ["custom:thing"])).toBe(true);
    expect(isSubsetOfCallerPerms(["custom:thing"], ["other"])).toBe(false);
  });

  it("a plain subset is allowed", () => {
    expect(isSubsetOfCallerPerms(["accounts:read"], ["accounts:read", "accounts:write"])).toBe(
      true,
    );
    expect(isSubsetOfCallerPerms(["accounts:delete"], ["accounts:read"])).toBe(false);
  });
});

describe("ALL_PERMISSIONS catalog", () => {
  it("is non-empty and unique", () => {
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(0);
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it("every entry is colon-delimited with no wildcards", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(p).not.toContain("*");
      expect(p).toMatch(/^[a-z-]+(:[a-z-]+)*$/);
    }
  });
});
