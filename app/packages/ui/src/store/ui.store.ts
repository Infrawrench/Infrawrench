import { create } from "zustand";

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
  setActiveDashboard: (id: string) => void;

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
}

export const useUIStore = create<UIState>((set) => ({
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
}));
