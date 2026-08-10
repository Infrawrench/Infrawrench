import { describe, expect, it } from "vitest";
import { migrateWorkspaceTabs } from "../ui.store";

/**
 * The Savings tab became a section of Costs. Anyone who had it open has it in
 * localStorage, and a tab whose kind no viewport case renders is a blank panel
 * the user can only close — so the v1 migration has to retarget it.
 */
const savingsTab = { id: "savings", target: { kind: "savings" }, title: "Savings" };
const costsTab = { id: "costs", target: { kind: "costs" }, title: "Costs" };
const dashboardTab = {
  id: "dashboard:main",
  target: { kind: "dashboard", dashboardId: "main" },
  title: "Home",
};

function persisted(tabs: unknown[], activeWorkspaceTabId: string | null = null) {
  return { workspaceTabs: tabs, activeWorkspaceTabId, activeCloudOrgId: "org-1" };
}

describe("migrateWorkspaceTabs", () => {
  it("retargets a savings tab to costs, keeping its position", () => {
    const result = migrateWorkspaceTabs(persisted([dashboardTab, savingsTab]), 0);

    expect(result.workspaceTabs.map((t) => t.target.kind)).toEqual(["dashboard", "costs"]);
    expect(result.workspaceTabs[1]).toEqual({
      id: "costs",
      target: { kind: "costs" },
      title: "Costs",
    });
  });

  it("drops the savings tab when costs is already open", () => {
    const result = migrateWorkspaceTabs(persisted([costsTab, savingsTab]), 0);

    expect(result.workspaceTabs).toEqual([costsTab]);
  });

  it("moves the active tab to costs when savings was active", () => {
    const result = migrateWorkspaceTabs(persisted([dashboardTab, savingsTab], "savings"), 0);

    expect(result.activeWorkspaceTabId).toBe("costs");
  });

  it("moves the active tab to the existing costs tab when savings was active", () => {
    const result = migrateWorkspaceTabs(persisted([costsTab, savingsTab], "savings"), 0);

    expect(result.activeWorkspaceTabId).toBe("costs");
    expect(result.workspaceTabs).toEqual([costsTab]);
  });

  it("leaves an unrelated active tab alone", () => {
    const result = migrateWorkspaceTabs(persisted([dashboardTab, savingsTab], "dashboard:main"), 0);

    expect(result.activeWorkspaceTabId).toBe("dashboard:main");
  });

  it("collapses several savings tabs into one costs tab", () => {
    const second = { ...savingsTab, id: "savings::2" };
    const result = migrateWorkspaceTabs(persisted([savingsTab, second]), 0);

    expect(result.workspaceTabs.map((t) => t.target.kind)).toEqual(["costs"]);
  });

  it("passes through state that has no savings tab", () => {
    const state = persisted([dashboardTab, costsTab], "costs");

    expect(migrateWorkspaceTabs(state, 0)).toBe(state);
  });

  it("leaves already-migrated state untouched", () => {
    const state = persisted([savingsTab], "savings");

    expect(migrateWorkspaceTabs(state, 1)).toBe(state);
  });

  it("survives persisted state with no tab list", () => {
    expect(() => migrateWorkspaceTabs({}, 0)).not.toThrow();
    expect(() => migrateWorkspaceTabs(undefined, 0)).not.toThrow();
  });
});
