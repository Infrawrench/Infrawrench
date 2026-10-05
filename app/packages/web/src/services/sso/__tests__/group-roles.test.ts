import { describe, expect, it } from "vitest";
import {
  emailDomain,
  isInVerifiedDomains,
  normalizeDomain,
  orderMappings,
  resolveDirectoryRole,
  type GroupRoleMapping,
} from "../group-roles";

const m = (id: string, group: string, role: string, position: number): GroupRoleMapping => ({
  id,
  directoryGroupId: group,
  groupName: group,
  roleId: role,
  position,
});

describe("resolveDirectoryRole", () => {
  const mappings = [m("m2", "g-eng", "role-member", 1), m("m1", "g-admins", "role-admin", 0)];

  it("first mapping in position order wins, and a split is flagged as a conflict", () => {
    const r = resolveDirectoryRole({
      groupIds: ["g-eng", "g-admins"],
      mappings,
      defaultRoleId: "role-default",
      currentIsOwner: false,
    });
    expect(r.roleId).toBe("role-admin");
    expect(r.mappingId).toBe("m1");
    expect(r.matchedMappingIds).toEqual(["m1", "m2"]);
    expect(r.conflict).toBe(true);
  });

  it("two matches naming the same role are not a conflict", () => {
    const r = resolveDirectoryRole({
      groupIds: ["a", "b"],
      mappings: [m("x", "a", "r", 0), m("y", "b", "r", 1)],
      defaultRoleId: "d",
      currentIsOwner: false,
    });
    expect(r.conflict).toBe(false);
  });

  it("no match falls back to the default role, so leaving a group takes its role away", () => {
    const r = resolveDirectoryRole({
      groupIds: ["g-other"],
      mappings,
      defaultRoleId: "role-default",
      currentIsOwner: false,
    });
    expect(r).toMatchObject({ roleId: "role-default", source: "default", mappingId: null });
  });

  it("never changes an owner, whatever their groups say", () => {
    const r = resolveDirectoryRole({
      groupIds: ["g-eng"],
      mappings,
      defaultRoleId: "role-default",
      currentIsOwner: true,
    });
    expect(r.roleId).toBeNull();
    expect(r.source).toBe("owner_unchanged");
  });

  it("orders ties by creation time, then id", () => {
    const a = { ...m("b", "g", "r1", 0), createdAt: "2026-01-02T00:00:00Z" };
    const b = { ...m("a", "g", "r2", 0), createdAt: "2026-01-01T00:00:00Z" };
    expect(orderMappings([a, b]).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("domains", () => {
  it("takes the domain after the last @, lower-cased", () => {
    expect(emailDomain("Jane@Example.COM")).toBe("example.com");
    expect(emailDomain('"a@evil.com"@corp.com')).toBe("corp.com");
    expect(emailDomain("nodomain")).toBeNull();
    expect(emailDomain("trailing@")).toBeNull();
  });

  it("matches verified domains exactly, never by suffix", () => {
    expect(isInVerifiedDomains("a@corp.com", ["corp.com"])).toBe(true);
    expect(isInVerifiedDomains("a@evilcorp.com", ["corp.com"])).toBe(false);
    expect(isInVerifiedDomains("a@eu.corp.com", ["corp.com"])).toBe(false);
    expect(isInVerifiedDomains(null, ["corp.com"])).toBe(false);
  });

  it("normalises a typed domain and rejects anything that is not a bare hostname", () => {
    expect(normalizeDomain(" Example.COM. ")).toBe("example.com");
    expect(normalizeDomain("eu.example.co.uk")).toBe("eu.example.co.uk");
    expect(normalizeDomain("https://example.com")).toBeNull();
    expect(normalizeDomain("example.com/path")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("exa mple.com")).toBeNull();
  });
});
