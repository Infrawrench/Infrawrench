import { describe, expect, it } from "vitest";

import {
  chooseDefaultDashboard,
  compareRoleDefaults,
  type RoleDefaultDashboard,
} from "../dashboard-defaults";

const role = (over: Partial<RoleDefaultDashboard>): RoleDefaultDashboard => ({
  roleId: "r-custom",
  roleName: "Finance",
  isSystem: false,
  systemKey: null,
  dashboardId: null,
  ...over,
});

const all = () => true;

describe("chooseDefaultDashboard", () => {
  it("falls back to the org default when nothing else is set", () => {
    const out = chooseDefaultDashboard(
      { userDefaultDashboardId: null, roles: [role({})], orgDefaultDashboardId: "org" },
      all,
    );
    expect(out).toMatchObject({
      dashboardId: "org",
      source: "org",
      roleDefault: null,
      skipped: [],
    });
  });

  it("prefers the role default over the org default", () => {
    const out = chooseDefaultDashboard(
      {
        userDefaultDashboardId: null,
        roles: [role({ dashboardId: "fin" })],
        orgDefaultDashboardId: "org",
      },
      all,
    );
    expect(out).toMatchObject({
      dashboardId: "fin",
      source: "role",
      roleDefault: { roleId: "r-custom", roleName: "Finance", dashboardId: "fin" },
    });
  });

  it("prefers the user's own default over the role default", () => {
    const out = chooseDefaultDashboard(
      {
        userDefaultDashboardId: "mine",
        roles: [role({ dashboardId: "fin" })],
        orgDefaultDashboardId: "org",
      },
      all,
    );
    expect(out.dashboardId).toBe("mine");
    expect(out.source).toBe("user");
    // The role default is still reported, so the UI can say what clearing would do.
    expect(out.roleDefault?.dashboardId).toBe("fin");
  });

  it("skips a user default the member can no longer open", () => {
    const out = chooseDefaultDashboard(
      {
        userDefaultDashboardId: "unshared",
        roles: [role({ dashboardId: "fin" })],
        orgDefaultDashboardId: "org",
      },
      (id) => id !== "unshared",
    );
    expect(out).toMatchObject({ dashboardId: "fin", source: "role", skipped: ["user"] });
    expect(out.userDefaultDashboardId).toBe("unshared");
  });

  it("skips an unopenable role default and lands on the org default", () => {
    const out = chooseDefaultDashboard(
      {
        userDefaultDashboardId: null,
        roles: [role({ dashboardId: "fin" })],
        orgDefaultDashboardId: "org",
      },
      (id) => id !== "fin",
    );
    expect(out).toMatchObject({ dashboardId: "org", source: "org", skipped: ["role"] });
    expect(out.roleDefault?.dashboardId).toBe("fin");
  });

  it("returns the org default even when it cannot be opened", () => {
    const out = chooseDefaultDashboard(
      { userDefaultDashboardId: null, roles: [], orgDefaultDashboardId: "org" },
      () => false,
    );
    expect(out.dashboardId).toBe("org");
  });

  it("with several roles, tries the next role when the first one's default is unshared", () => {
    const out = chooseDefaultDashboard(
      {
        userDefaultDashboardId: null,
        roles: [
          role({
            roleId: "sys-admin",
            roleName: "Admin",
            isSystem: true,
            systemKey: "admin",
            dashboardId: "ops",
          }),
          role({ roleId: "c1", roleName: "Finance", dashboardId: "fin" }),
        ],
        orgDefaultDashboardId: "org",
      },
      (id) => id !== "fin",
    );
    expect(out).toMatchObject({ dashboardId: "ops", source: "role" });
    expect(out.roleDefault?.roleId).toBe("sys-admin");
  });
});

describe("compareRoleDefaults", () => {
  it("orders custom roles first, then system roles by rank, then by name and id", () => {
    const roles = [
      role({ roleId: "m", roleName: "Member", isSystem: true, systemKey: "member" }),
      role({ roleId: "o", roleName: "Owner", isSystem: true, systemKey: "owner" }),
      role({ roleId: "b", roleName: "SRE" }),
      role({ roleId: "a2", roleName: "Finance" }),
      role({ roleId: "a1", roleName: "Finance" }),
      role({ roleId: "ad", roleName: "Admin", isSystem: true, systemKey: "admin" }),
    ];
    expect(
      roles
        .slice()
        .sort(compareRoleDefaults)
        .map((r) => r.roleId),
    ).toEqual(["a1", "a2", "b", "o", "ad", "m"]);
  });

  it("does not depend on input order", () => {
    const a = role({ roleId: "x", roleName: "Ops", dashboardId: "1" });
    const b = role({ roleId: "y", roleName: "Finance", dashboardId: "2" });
    const one = chooseDefaultDashboard(
      { userDefaultDashboardId: null, roles: [a, b], orgDefaultDashboardId: "org" },
      all,
    );
    const two = chooseDefaultDashboard(
      { userDefaultDashboardId: null, roles: [b, a], orgDefaultDashboardId: "org" },
      all,
    );
    expect(one.dashboardId).toBe("2");
    expect(two.dashboardId).toBe("2");
  });
});
