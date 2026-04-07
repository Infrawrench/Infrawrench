import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type WorkspaceTabTarget =
  | { kind: "dashboard"; dashboardId: string }
  | { kind: "account"; accountId: string }
  | { kind: "resource"; accountId: string; resourceId: string; view?: "details" | "ssh" };

export interface WorkspaceTab {
  id: string;
  target: WorkspaceTabTarget;
  title: string;
}

const WORKSPACE_TABS_STORAGE_KEY = "infrawrench-workspace-tabs";

export function normalizeResourceId(resourceId: string): string {
  try {
    return decodeURIComponent(resourceId);
  } catch {
    return resourceId;
  }
}

export function getWorkspaceTabId(target: WorkspaceTabTarget): string {
  switch (target.kind) {
    case "dashboard":
      return `dashboard:${target.dashboardId}`;
    case "account":
      return `account:${target.accountId}`;
    case "resource":
      return target.view === "ssh"
        ? `resource:${target.accountId}:${normalizeResourceId(target.resourceId)}:ssh`
        : `resource:${target.accountId}:${normalizeResourceId(target.resourceId)}`;
  }
}

export function getWorkspaceTabFallbackTitle(target: WorkspaceTabTarget): string {
  switch (target.kind) {
    case "dashboard":
      return "Dashboard";
    case "account":
      return "Account";
    case "resource":
      return target.view === "ssh" ? "SSH" : "Resource";
  }
}

function createWorkspaceTab(target: WorkspaceTabTarget, title?: string): WorkspaceTab {
  return {
    id: getWorkspaceTabId(target),
    target: target.kind === "resource"
      ? { ...target, resourceId: normalizeResourceId(target.resourceId), view: target.view ?? "details" }
      : target,
    title: title?.trim() || getWorkspaceTabFallbackTitle(target),
  };
}

function upsertWorkspaceTabTitle(tab: WorkspaceTab, title?: string): WorkspaceTab {
  if (!title?.trim() || title === tab.title) return tab;
  return { ...tab, title };
}

function applyWorkspaceNavigation(
  tabs: WorkspaceTab[],
  activeTabId: string | null,
  target: WorkspaceTabTarget,
  title: string | undefined,
  mode: "reuse-active" | "pin",
): Pick<UIState, "workspaceTabs" | "activeWorkspaceTabId"> {
  const nextTab = createWorkspaceTab(target, title);
  const existing = tabs.find((tab) => tab.id === nextTab.id);

  if (existing) {
    return {
      workspaceTabs: tabs.map((tab) => tab.id === nextTab.id ? upsertWorkspaceTabTitle(tab, title) : tab),
      activeWorkspaceTabId: nextTab.id,
    };
  }

  if (mode === "pin") {
    const activeIndex = activeTabId ? tabs.findIndex((tab) => tab.id === activeTabId) : -1;
    const insertAt = activeIndex >= 0 ? activeIndex + 1 : tabs.length;
    return {
      workspaceTabs: [...tabs.slice(0, insertAt), nextTab, ...tabs.slice(insertAt)],
      activeWorkspaceTabId: nextTab.id,
    };
  }

  if (!activeTabId) {
    return { workspaceTabs: [...tabs, nextTab], activeWorkspaceTabId: nextTab.id };
  }

  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  if (activeIndex === -1) {
    return { workspaceTabs: [...tabs, nextTab], activeWorkspaceTabId: nextTab.id };
  }

  return {
    workspaceTabs: tabs.map((tab, index) => index === activeIndex ? nextTab : tab),
    activeWorkspaceTabId: nextTab.id,
  };
}

interface UIState {
  /** Currently selected resource for detail view */
  selectedResource: { pluginId: string; resourceTypeId: string; resourceId: string } | null;
  selectResource: (
    pluginId: string,
    resourceTypeId: string,
    resourceId: string,
  ) => void;
  clearSelection: () => void;

  /** Sidebar collapsed state */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  /** Active dashboard ID */
  activeDashboardId: string | null;
  setActiveDashboard: (id: string | null) => void;

  /** The field key being "rerolled" — triggers AssociationPicker modal */
  rerollingField: { resourceId: string; fieldKey: string } | null;
  openReroll: (resourceId: string, fieldKey: string) => void;
  closeReroll: () => void;

  /** Account IDs with a live verified connection */
  connectedAccounts: Set<string>;
  setAccountConnected: (accountId: string, connected: boolean) => void;

  /** Increment to tell DashboardView to reload its pins */
  dashboardPinsVersion: number;
  bumpDashboardPins: () => void;

  /** Increment to tell SidebarAccounts to reload */
  accountsVersion: number;
  bumpAccounts: () => void;

  /** Global non-modal workspace tabs */
  workspaceTabs: WorkspaceTab[];
  activeWorkspaceTabId: string | null;
  tabsHydrated: boolean;
  openInActiveWorkspaceTab: (target: WorkspaceTabTarget, title?: string) => void;
  pinWorkspaceTab: (target: WorkspaceTabTarget, title?: string) => void;
  syncWorkspaceRoute: (target: WorkspaceTabTarget, title?: string) => void;
  activateWorkspaceTab: (tabId: string) => void;
  closeWorkspaceTab: (tabId: string) => void;
  reorderWorkspaceTabs: (activeId: string, overId: string) => void;
  setWorkspaceTabTitle: (tabId: string, title: string) => void;
  replaceWorkspaceTabs: (tabs: WorkspaceTab[], activeTabId?: string | null) => void;
  removeWorkspaceTabs: (tabIds: string[]) => void;
  setTabsHydrated: (hydrated: boolean) => void;
}

export const useUIStore = create<UIState>()(persist((set) => ({
  selectedResource: null,
  selectResource: (pluginId, resourceTypeId, resourceId) =>
    set({ selectedResource: { pluginId, resourceTypeId, resourceId } }),
  clearSelection: () => set({ selectedResource: null }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  activeDashboardId: null,
  setActiveDashboard: (id) => set({ activeDashboardId: id }),

  rerollingField: null,
  openReroll: (resourceId, fieldKey) => set({ rerollingField: { resourceId, fieldKey } }),
  closeReroll: () => set({ rerollingField: null }),

  connectedAccounts: new Set(),
  setAccountConnected: (accountId, connected) =>
    set((s) => {
      const next = new Set(s.connectedAccounts);
      if (connected) next.add(accountId);
      else next.delete(accountId);
      return { connectedAccounts: next };
    }),

  dashboardPinsVersion: 0,
  bumpDashboardPins: () => set((s) => ({ dashboardPinsVersion: s.dashboardPinsVersion + 1 })),

  accountsVersion: 0,
  bumpAccounts: () => set((s) => ({ accountsVersion: s.accountsVersion + 1 })),

  workspaceTabs: [],
  activeWorkspaceTabId: null,
  tabsHydrated: false,
  openInActiveWorkspaceTab: (target, title) =>
    set((state) => applyWorkspaceNavigation(
      state.workspaceTabs,
      state.activeWorkspaceTabId,
      target,
      title,
      "reuse-active",
    )),
  pinWorkspaceTab: (target, title) =>
    set((state) => applyWorkspaceNavigation(
      state.workspaceTabs,
      state.activeWorkspaceTabId,
      target,
      title,
      "pin",
    )),
  syncWorkspaceRoute: (target, title) =>
    set((state) => applyWorkspaceNavigation(
      state.workspaceTabs,
      state.activeWorkspaceTabId,
      target,
      title,
      "reuse-active",
    )),
  activateWorkspaceTab: (tabId) => set({ activeWorkspaceTabId: tabId }),
  closeWorkspaceTab: (tabId) =>
    set((state) => {
      const index = state.workspaceTabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) return state;
      const nextTabs = state.workspaceTabs.filter((tab) => tab.id !== tabId);
      const nextActiveTabId = state.activeWorkspaceTabId === tabId
        ? nextTabs[index]?.id ?? nextTabs[index - 1]?.id ?? nextTabs[0]?.id ?? null
        : state.activeWorkspaceTabId;
      return { workspaceTabs: nextTabs, activeWorkspaceTabId: nextActiveTabId };
    }),
  reorderWorkspaceTabs: (activeId, overId) =>
    set((state) => {
      if (activeId === overId) return state;
      const fromIndex = state.workspaceTabs.findIndex((tab) => tab.id === activeId);
      const toIndex = state.workspaceTabs.findIndex((tab) => tab.id === overId);
      if (fromIndex === -1 || toIndex === -1) return state;
      const nextTabs = [...state.workspaceTabs];
      const [moved] = nextTabs.splice(fromIndex, 1);
      if (!moved) return state;
      nextTabs.splice(toIndex, 0, moved);
      return { workspaceTabs: nextTabs };
    }),
  setWorkspaceTabTitle: (tabId, title) =>
    set((state) => ({
      workspaceTabs: state.workspaceTabs.map((tab) => tab.id === tabId ? upsertWorkspaceTabTitle(tab, title) : tab),
    })),
  replaceWorkspaceTabs: (tabs, activeTabId) =>
    set(() => {
      const deduped = Array.from(new Map(tabs.map((tab) => [tab.id, createWorkspaceTab(tab.target, tab.title)])).values());
      return {
        workspaceTabs: deduped,
        activeWorkspaceTabId: deduped.some((tab) => tab.id === activeTabId)
          ? activeTabId ?? null
          : deduped[0]?.id ?? null,
      };
    }),
  removeWorkspaceTabs: (tabIds) =>
    set((state) => {
      if (tabIds.length === 0) return state;
      const nextTabs = state.workspaceTabs.filter((tab) => !tabIds.includes(tab.id));
      return {
        workspaceTabs: nextTabs,
        activeWorkspaceTabId: nextTabs.some((tab) => tab.id === state.activeWorkspaceTabId)
          ? state.activeWorkspaceTabId
          : nextTabs[0]?.id ?? null,
      };
    }),
  setTabsHydrated: (hydrated) => set({ tabsHydrated: hydrated }),
}), {
  name: WORKSPACE_TABS_STORAGE_KEY,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    workspaceTabs: state.workspaceTabs,
    activeWorkspaceTabId: state.activeWorkspaceTabId,
  }),
  onRehydrateStorage: () => (state) => {
    state?.setTabsHydrated(true);
  },
}));
