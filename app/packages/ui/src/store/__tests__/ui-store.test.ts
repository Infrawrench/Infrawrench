import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "../ui.store";

function resetStore() {
  useUIStore.setState({
    selectedResource: null,
    sidebarCollapsed: false,
    rerollingField: null,
    connectedAccounts: new Set(),
    dashboardPinsVersion: 0,
    accountsVersion: 0,
  });
}

describe("selectResource / clearSelection", () => {
  beforeEach(resetStore);

  it("sets selectedResource", () => {
    useUIStore.getState().selectResource("plugin-1", "vm", "res-42");
    expect(useUIStore.getState().selectedResource).toEqual({
      pluginId: "plugin-1",
      resourceTypeId: "vm",
      resourceId: "res-42",
    });
  });

  it("clears selectedResource", () => {
    useUIStore.getState().selectResource("plugin-1", "vm", "res-42");
    useUIStore.getState().clearSelection();
    expect(useUIStore.getState().selectedResource).toBeNull();
  });
});

describe("toggleSidebar", () => {
  beforeEach(resetStore);

  it("toggles sidebarCollapsed from false to true", () => {
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it("toggles back to false", () => {
    useUIStore.getState().toggleSidebar();
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });
});

describe("bumpDashboardPins", () => {
  beforeEach(resetStore);

  it("increments dashboardPinsVersion", () => {
    expect(useUIStore.getState().dashboardPinsVersion).toBe(0);
    useUIStore.getState().bumpDashboardPins();
    expect(useUIStore.getState().dashboardPinsVersion).toBe(1);
    useUIStore.getState().bumpDashboardPins();
    expect(useUIStore.getState().dashboardPinsVersion).toBe(2);
  });
});

describe("bumpAccounts", () => {
  beforeEach(resetStore);

  it("increments accountsVersion", () => {
    expect(useUIStore.getState().accountsVersion).toBe(0);
    useUIStore.getState().bumpAccounts();
    expect(useUIStore.getState().accountsVersion).toBe(1);
  });
});

describe("setAccountConnected", () => {
  beforeEach(resetStore);

  it("adds account to connectedAccounts when connected is true", () => {
    useUIStore.getState().setAccountConnected("acc-1", true);
    expect(useUIStore.getState().connectedAccounts.has("acc-1")).toBe(true);
  });

  it("removes account from connectedAccounts when connected is false", () => {
    useUIStore.getState().setAccountConnected("acc-1", true);
    useUIStore.getState().setAccountConnected("acc-1", false);
    expect(useUIStore.getState().connectedAccounts.has("acc-1")).toBe(false);
  });

  it("handles multiple accounts independently", () => {
    useUIStore.getState().setAccountConnected("acc-1", true);
    useUIStore.getState().setAccountConnected("acc-2", true);
    useUIStore.getState().setAccountConnected("acc-1", false);
    expect(useUIStore.getState().connectedAccounts.has("acc-1")).toBe(false);
    expect(useUIStore.getState().connectedAccounts.has("acc-2")).toBe(true);
  });
});

describe("openReroll / closeReroll", () => {
  beforeEach(resetStore);

  it("sets rerollingField with resourceId and fieldKey", () => {
    useUIStore.getState().openReroll("res-1", "field-a");
    expect(useUIStore.getState().rerollingField).toEqual({
      resourceId: "res-1",
      fieldKey: "field-a",
    });
  });

  it("clears rerollingField", () => {
    useUIStore.getState().openReroll("res-1", "field-a");
    useUIStore.getState().closeReroll();
    expect(useUIStore.getState().rerollingField).toBeNull();
  });
});
