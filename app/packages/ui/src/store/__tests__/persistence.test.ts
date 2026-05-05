import { describe, expect, it } from "vitest";
import { useUIStore } from "../ui.store";

describe("persist middleware partialize", () => {
  it("only persists workspaceTabs and activeWorkspaceTabId", () => {
    const initial = useUIStore.getInitialState();

    expect(initial).toHaveProperty("workspaceTabs");
    expect(initial).toHaveProperty("activeWorkspaceTabId");

    useUIStore.setState({
      selectedResource: { pluginId: "p", resourceTypeId: "r", resourceId: "id" },
      sidebarCollapsed: true,
      dashboardPinsVersion: 5,
      accountsVersion: 3,
      rerollingField: { resourceId: "r1", fieldKey: "f1" },
      workspaceTabs: [
        {
          id: "dashboard:main",
          target: { kind: "dashboard", dashboardId: "main" },
          title: "Home",
        },
      ],
      activeWorkspaceTabId: "dashboard:main",
    });

    const state = useUIStore.getState();

    expect(state.workspaceTabs).toHaveLength(1);
    expect(state.activeWorkspaceTabId).toBe("dashboard:main");

    expect(state.selectedResource).toEqual({
      pluginId: "p",
      resourceTypeId: "r",
      resourceId: "id",
    });
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.dashboardPinsVersion).toBe(5);

    expect(initial.selectedResource).toBeNull();
    expect(initial.sidebarCollapsed).toBe(false);
    expect(initial.dashboardPinsVersion).toBe(0);
    expect(initial.accountsVersion).toBe(0);
    expect(initial.rerollingField).toBeNull();
    expect(initial.tabsHydrated).toBe(false);

    expect(initial.workspaceTabs).toEqual([]);
    expect(initial.activeWorkspaceTabId).toBeNull();
  });

  it("persists with storage key 'infrawrench-workspace-tabs'", async () => {
    const state = useUIStore.getState();
    expect(typeof state.openInActiveWorkspaceTab).toBe("function");
    expect(typeof state.pinWorkspaceTab).toBe("function");
    expect(typeof state.setTabsHydrated).toBe("function");
  });
});
