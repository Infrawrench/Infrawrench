import { describe, expect, it } from "vitest";
import { describeLanding } from "../cli/commands/dashboards";

const base = {
  dashboardId: "d1",
  dashboardName: "Finance",
  userDefaultDashboardId: null,
  roleDefault: null,
  orgDefaultDashboardId: "home",
  skipped: [],
} as const;

describe("dashboards CLI: your default", () => {
  it("says which layer the default came from", () => {
    expect(describeLanding({ ...base, source: "user", skipped: [] })).toBe("your choice");
    expect(
      describeLanding({
        ...base,
        source: "role",
        roleDefault: { roleId: "r", roleName: "Finance", dashboardId: "d1" },
        skipped: [],
      }),
    ).toBe("default for the Finance role");
    expect(describeLanding({ ...base, source: "org", skipped: [] })).toBe("organization default");
  });
});
