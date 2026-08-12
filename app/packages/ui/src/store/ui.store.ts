import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type WorkspaceTabTarget =
  | { kind: "dashboard"; dashboardId: string }
  | { kind: "account"; accountId: string }
  | { kind: "agents" }
  | { kind: "costs" }
  | { kind: "cost-reports"; reportId?: string }
  | { kind: "invoices"; invoiceId?: string }
  | { kind: "graph" }
  | { kind: "logs" }
  | { kind: "changes" }
  | { kind: "expiring" }
  | { kind: "posture" }
  | { kind: "access-review" }
  | { kind: "backups" }
  | { kind: "dns" }
  | { kind: "iac" }
  | { kind: "environment-diff"; a?: string; b?: string }
  | { kind: "environments" }
  | { kind: "ssh-fanout" }
  | { kind: "metric-alerts" }
  | { kind: "probes" }
  | { kind: "status-pages" }
  | { kind: "quotas" }
  /**
   * Declared incidents (incident mode). Single-instance like Probes; the
   * detail view is addressed inside the panel rather than by tab, so an
   * operator flipping between two incidents keeps one tab.
   */
  | { kind: "incidents"; incidentId?: string }
  | { kind: "workflows"; workflowId?: string }
  | { kind: "deployments"; repo?: string }
  | { kind: "settings"; section?: string }
  | { kind: "chat"; conversationId?: string }
  | {
      kind: "resource";
      accountId: string;
      resourceId: string;
      view?: "details" | "ssh" | "sftp";
      pluginId?: string | undefined;
      resourceTypeId?: string | undefined;
      parentResourceId?: string | undefined;
      agentSessionId?: string;
      sshKeyId?: string | undefined;
      sshKeyName?: string | undefined;
      initialCommand?: string | undefined;
      initialCwd?: string | undefined;
    };

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
    case "agents":
      return "agents";
    case "costs":
      return "costs";
    case "cost-reports":
      // Not keyed by report: opening a second report should retarget the open
      // Cost reports tab rather than pile up a tab per report.
      return "cost-reports";
    case "invoices":
      // Same as Cost reports: one Invoices tab whose open invoice is remembered
      // state, not a tab per invoice. A month of invoices is a list to work
      // down, and a tab each would bury every other tab in the workspace.
      return "invoices";
    case "graph":
      return "graph";
    case "logs":
      return "logs";
    case "changes":
      return "changes";
    case "expiring":
      return "expiring";
    case "posture":
      return "posture";
    case "access-review":
      return "access-review";
    case "backups":
      return "backups";
    case "dns":
      return "dns";
    case "iac":
      return "iac";
    // Not keyed by the two accounts: picking a different pair should retarget
    // the open Diff tab rather than pile up a tab per comparison.
    case "environment-diff":
      return "environment-diff";
    case "environments":
      return "environments";
    case "ssh-fanout":
      return "ssh-fanout";
    case "metric-alerts":
      return "metric-alerts";
    case "probes":
      return "probes";
    case "status-pages":
      return "status-pages";
    case "quotas":
      return "quotas";
    case "incidents":
      return "incidents";
    case "workflows":
      return target.workflowId ? `workflows:${target.workflowId}` : "workflows";
    case "deployments":
      // Not keyed by repo: a hotlink to a different repo should retarget the
      // open Deploy tab rather than pile up a tab per repository.
      return "deployments";
    case "settings":
      // Not keyed by section: one Settings tab that remembers where you were.
      return "settings";
    case "chat":
      return target.conversationId ? `chat:${target.conversationId}` : "chat";
    case "resource":
      if (target.view === "ssh") {
        const suffix = target.agentSessionId ? `:agent:${target.agentSessionId}` : "";
        return `resource:${target.accountId}:${normalizeResourceId(target.resourceId)}:ssh${suffix}`;
      }
      if (target.view === "sftp")
        return `resource:${target.accountId}:${normalizeResourceId(target.resourceId)}:sftp`;
      return `resource:${target.accountId}:${normalizeResourceId(target.resourceId)}`;
  }
}

export function getWorkspaceTabFallbackTitle(target: WorkspaceTabTarget): string {
  switch (target.kind) {
    case "dashboard":
      return "Dashboard";
    case "account":
      return "Account";
    case "agents":
      return "Agents";
    case "costs":
      return "Costs";
    case "cost-reports":
      return "Reports";
    case "invoices":
      return "Invoices";
    case "graph":
      return "Graph";
    case "logs":
      return "Logs";
    case "changes":
      return "Changes";
    case "expiring":
      return "Expiring";
    case "posture":
      return "Posture";
    case "access-review":
      return "Access review";
    case "backups":
      return "Backups";
    case "dns":
      return "Domains";
    case "iac":
      return "IaC";
    case "environment-diff":
      return "Env diff";
    case "environments":
      return "Environments";
    // Titles match the sidebar tiles the pages are opened from.
    case "ssh-fanout":
      return "Fan-out";
    case "metric-alerts":
      return "Alerts";
    case "probes":
      return "Probes";
    case "status-pages":
      return "Status pages";
    case "quotas":
      return "Quotas";
    case "incidents":
      return "Incidents";
    case "workflows":
      return "Workflows";
    case "deployments":
      // "Deploy" everywhere the user reads it — the sidebar tile, the panel
      // heading and the docs all say Deploy; only the tab used to disagree.
      return "Deploy";
    case "settings":
      return "Settings";
    case "chat":
      return "Chat";
    case "resource":
      if (target.view === "ssh") return "SSH";
      if (target.view === "sftp") return "SFTP";
      return "Resource";
  }
}

export function workspaceTabTargetsEqual(a: WorkspaceTabTarget, b: WorkspaceTabTarget): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "dashboard":
      return a.dashboardId === (b as { dashboardId: string }).dashboardId;
    case "account":
      return a.accountId === (b as { accountId: string }).accountId;
    case "agents":
    case "costs":
    case "graph":
    case "logs":
    case "changes":
    case "expiring":
    case "posture":
    case "access-review":
    case "backups":
    case "dns":
    case "iac":
    case "environments":
    case "ssh-fanout":
    case "metric-alerts":
    case "probes":
    case "status-pages":
    case "quotas":
      return true;
    case "incidents":
      // The deployments/settings trick: one tab by id, but comparing the
      // incident is what makes the route sync record which one the tab is on,
      // so reactivating it lands back on that incident rather than the list.
      return a.incidentId === (b as { incidentId?: string }).incidentId;
    case "cost-reports":
      // The deployments/settings trick: one tab by id, but comparing the report
      // is what makes the route sync record which report the tab is on, so
      // reactivating it restores that report rather than the bare list.
      return a.reportId === (b as { reportId?: string }).reportId;
    case "invoices":
      // Its own arm rather than the payload-free fallthrough above, for the
      // same reason: comparing the invoice is what records which one the tab is
      // on, so reactivating it comes back to that invoice and not the list.
      return a.invoiceId === (b as { invoiceId?: string }).invoiceId;
    case "deployments":
      // Compared even though the tab *id* ignores it: the id keeps a second
      // hotlink reusing one tab, while this comparison is what makes the route
      // sync notice the repo changed and actually retarget it.
      return a.repo === (b as { repo?: string }).repo;
    // Same trick: one Diff tab by id, but comparing the two accounts lets the
    // route sync record which comparison the tab is showing.
    case "environment-diff": {
      const other = b as { a?: string; b?: string };
      return a.a === other.a && a.b === other.b;
    }
    case "settings":
      // Same deployments trick: single tab by id, but comparing the section
      // lets the route sync record which settings page the tab is on.
      return a.section === (b as { section?: string }).section;
    case "workflows":
      return a.workflowId === (b as { workflowId?: string }).workflowId;
    case "chat":
      return a.conversationId === (b as { conversationId?: string }).conversationId;
    case "resource":
      return (
        a.accountId === (b as { accountId: string }).accountId &&
        normalizeResourceId(a.resourceId) ===
          normalizeResourceId((b as { resourceId: string }).resourceId) &&
        (a.view ?? "details") ===
          ((b as { view?: "details" | "ssh" | "sftp" }).view ?? "details") &&
        a.agentSessionId === (b as { agentSessionId?: string }).agentSessionId &&
        a.sshKeyId === (b as { sshKeyId?: string }).sshKeyId &&
        a.sshKeyName === (b as { sshKeyName?: string }).sshKeyName
      );
  }
}

function createWorkspaceTab(target: WorkspaceTabTarget, title?: string, id?: string): WorkspaceTab {
  return {
    id: id ?? getWorkspaceTabId(target),
    target:
      target.kind === "resource"
        ? {
            ...target,
            resourceId: normalizeResourceId(target.resourceId),
            view: target.view ?? "details",
          }
        : target,
    title: title?.trim() || getWorkspaceTabFallbackTitle(target),
  };
}

/** Bumped whenever a stored tab shape stops being renderable. See migrateWorkspaceTabs. */
const PERSISTED_TABS_VERSION = 1;

interface PersistedWorkspaceTabs {
  workspaceTabs: WorkspaceTab[];
  activeWorkspaceTabId: string | null;
  activeCloudOrgId: string | null;
}

/**
 * `savings` was its own tab kind until the panel became a section of Costs.
 * Stored tabs are typed as current targets, so the dead kind needs a widening
 * cast to be recognised at all.
 */
function isRetiredSavingsTab(tab: WorkspaceTab): boolean {
  return (tab.target as { kind: string }).kind === "savings";
}

/**
 * v1: fold any open Savings tab into Costs. Without this the tab rehydrates
 * with a kind no viewport case renders — a permanently blank tab the user can
 * only close.
 */
export function migrateWorkspaceTabs(persisted: unknown, version: number): PersistedWorkspaceTabs {
  const state = persisted as PersistedWorkspaceTabs;
  if (version >= PERSISTED_TABS_VERSION || !Array.isArray(state?.workspaceTabs)) return state;

  const retired = state.workspaceTabs.filter(isRetiredSavingsTab);
  if (retired.length === 0) return state;

  // Retarget the first one in place so it keeps its position in the strip, and
  // drop the rest — duplicate ids would break tab selection. If Costs is
  // already open there is nothing to retarget onto.
  const hasCosts = state.workspaceTabs.some((tab) => tab.target.kind === "costs");
  const workspaceTabs = state.workspaceTabs.flatMap((tab) => {
    if (!isRetiredSavingsTab(tab)) return [tab];
    if (hasCosts || tab !== retired[0]) return [];
    return [createWorkspaceTab({ kind: "costs" })];
  });

  const wasActive = retired.some((tab) => tab.id === state.activeWorkspaceTabId);
  return {
    ...state,
    workspaceTabs,
    activeWorkspaceTabId: wasActive
      ? (workspaceTabs.find((tab) => tab.target.kind === "costs")?.id ??
        workspaceTabs[0]?.id ??
        null)
      : state.activeWorkspaceTabId,
  };
}

function createWorkspaceTabInstance(target: WorkspaceTabTarget, title?: string): WorkspaceTab {
  return createWorkspaceTab(target, title, `${getWorkspaceTabId(target)}::${crypto.randomUUID()}`);
}

function upsertWorkspaceTabTitle(tab: WorkspaceTab, title?: string): WorkspaceTab {
  if (!title?.trim() || title === tab.title) return tab;
  return { ...tab, title };
}

function updateWorkspaceTab(
  tab: WorkspaceTab,
  target: WorkspaceTabTarget,
  title?: string,
): WorkspaceTab {
  const next = createWorkspaceTab(mergeWorkspaceTabTarget(tab.target, target), title, tab.id);
  return {
    ...next,
    title: title?.trim() || tab.title,
  };
}

function mergeWorkspaceTabTarget(
  existing: WorkspaceTabTarget,
  next: WorkspaceTabTarget,
): WorkspaceTabTarget {
  if (existing.kind !== "resource" || next.kind !== "resource") return next;
  if (existing.accountId !== next.accountId) return next;
  if (normalizeResourceId(existing.resourceId) !== normalizeResourceId(next.resourceId))
    return next;
  if ((existing.view ?? "details") !== (next.view ?? "details")) return next;
  if (existing.agentSessionId !== next.agentSessionId) return next;
  return {
    ...next,
    pluginId: next.pluginId ?? existing.pluginId,
    resourceTypeId: next.resourceTypeId ?? existing.resourceTypeId,
    parentResourceId: next.parentResourceId ?? existing.parentResourceId,
    sshKeyId: next.sshKeyId ?? existing.sshKeyId,
    sshKeyName: next.sshKeyName ?? existing.sshKeyName,
    initialCommand: next.initialCommand ?? existing.initialCommand,
    initialCwd: next.initialCwd ?? existing.initialCwd,
  };
}

function applyWorkspaceNavigation(
  tabs: WorkspaceTab[],
  activeTabId: string | null,
  target: WorkspaceTabTarget,
  title: string | undefined,
  mode: "reuse-active" | "pin",
): Pick<UIState, "workspaceTabs" | "activeWorkspaceTabId"> {
  const nextTab = createWorkspaceTab(target, title);
  const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : undefined;

  const existingById = tabs.find((tab) => tab.id === nextTab.id);
  if (existingById) {
    return {
      workspaceTabs: tabs.map((tab) =>
        tab.id === existingById.id ? updateWorkspaceTab(tab, target, title) : tab,
      ),
      activeWorkspaceTabId: existingById.id,
    };
  }

  if (activeTab && workspaceTabTargetsEqual(activeTab.target, nextTab.target)) {
    return {
      workspaceTabs: tabs.map((tab) =>
        tab.id === activeTab.id ? updateWorkspaceTab(tab, target, title) : tab,
      ),
      activeWorkspaceTabId: activeTab.id,
    };
  }

  const existing = tabs.find((tab) => workspaceTabTargetsEqual(tab.target, nextTab.target));

  if (existing) {
    return {
      workspaceTabs: tabs.map((tab) =>
        tab.id === existing.id ? updateWorkspaceTab(tab, target, title) : tab,
      ),
      activeWorkspaceTabId: existing.id,
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
    workspaceTabs: tabs.map((tab, index) => (index === activeIndex ? nextTab : tab)),
    activeWorkspaceTabId: nextTab.id,
  };
}

interface UIState {
  /** Currently selected resource for detail view */
  selectedResource: { pluginId: string; resourceTypeId: string; resourceId: string } | null;
  selectResource: (pluginId: string, resourceTypeId: string, resourceId: string) => void;
  clearSelection: () => void;

  /** Sidebar collapsed state */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  /** Active dashboard ID */
  activeDashboardId: string | null;
  setActiveDashboard: (id: string | null) => void;

  /** Active cloud org ID — null means local-only mode (desktop) */
  activeCloudOrgId: string | null;
  setActiveCloudOrgId: (id: string | null) => void;

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
  createWorkspaceTabInstance: (target: WorkspaceTabTarget, title?: string) => void;
  syncWorkspaceRoute: (target: WorkspaceTabTarget, title?: string) => void;
  activateWorkspaceTab: (tabId: string) => void;
  closeWorkspaceTab: (tabId: string) => void;
  reorderWorkspaceTabs: (activeId: string, overId: string) => void;
  setWorkspaceTabTitle: (tabId: string, title: string) => void;
  replaceWorkspaceTabs: (tabs: WorkspaceTab[], activeTabId?: string | null) => void;
  removeWorkspaceTabs: (tabIds: string[]) => void;
  setTabsHydrated: (hydrated: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      selectedResource: null,
      selectResource: (pluginId, resourceTypeId, resourceId) =>
        set({ selectedResource: { pluginId, resourceTypeId, resourceId } }),
      clearSelection: () => set({ selectedResource: null }),

      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      activeDashboardId: null,
      setActiveDashboard: (id) => set({ activeDashboardId: id }),

      activeCloudOrgId: null,
      setActiveCloudOrgId: (id) => set({ activeCloudOrgId: id }),

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
        set((state) =>
          applyWorkspaceNavigation(
            state.workspaceTabs,
            state.activeWorkspaceTabId,
            target,
            title,
            "reuse-active",
          ),
        ),
      pinWorkspaceTab: (target, title) =>
        set((state) =>
          applyWorkspaceNavigation(
            state.workspaceTabs,
            state.activeWorkspaceTabId,
            target,
            title,
            "pin",
          ),
        ),
      createWorkspaceTabInstance: (target, title) =>
        set((state) => {
          const nextTab = createWorkspaceTabInstance(target, title);
          const activeIndex = state.activeWorkspaceTabId
            ? state.workspaceTabs.findIndex((tab) => tab.id === state.activeWorkspaceTabId)
            : -1;
          const insertAt = activeIndex >= 0 ? activeIndex + 1 : state.workspaceTabs.length;
          return {
            workspaceTabs: [
              ...state.workspaceTabs.slice(0, insertAt),
              nextTab,
              ...state.workspaceTabs.slice(insertAt),
            ],
            activeWorkspaceTabId: nextTab.id,
          };
        }),
      syncWorkspaceRoute: (target, title) =>
        set((state) =>
          applyWorkspaceNavigation(
            state.workspaceTabs,
            state.activeWorkspaceTabId,
            target,
            title,
            "reuse-active",
          ),
        ),
      activateWorkspaceTab: (tabId) => set({ activeWorkspaceTabId: tabId }),
      closeWorkspaceTab: (tabId) =>
        set((state) => {
          const index = state.workspaceTabs.findIndex((tab) => tab.id === tabId);
          if (index === -1) return state;
          const nextTabs = state.workspaceTabs.filter((tab) => tab.id !== tabId);
          const nextActiveTabId =
            state.activeWorkspaceTabId === tabId
              ? (nextTabs[index]?.id ?? nextTabs[index - 1]?.id ?? nextTabs[0]?.id ?? null)
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
          workspaceTabs: state.workspaceTabs.map((tab) =>
            tab.id === tabId ? upsertWorkspaceTabTitle(tab, title) : tab,
          ),
        })),
      replaceWorkspaceTabs: (tabs, activeTabId) =>
        set(() => {
          const deduped = Array.from(
            new Map(
              tabs.map((tab) => [tab.id, createWorkspaceTab(tab.target, tab.title, tab.id)]),
            ).values(),
          );
          return {
            workspaceTabs: deduped,
            activeWorkspaceTabId: deduped.some((tab) => tab.id === activeTabId)
              ? (activeTabId ?? null)
              : (deduped[0]?.id ?? null),
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
              : (nextTabs[0]?.id ?? null),
          };
        }),
      setTabsHydrated: (hydrated) => set({ tabsHydrated: hydrated }),
    }),
    {
      name: WORKSPACE_TABS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: PERSISTED_TABS_VERSION,
      migrate: migrateWorkspaceTabs,
      partialize: (state) => ({
        workspaceTabs: state.workspaceTabs,
        activeWorkspaceTabId: state.activeWorkspaceTabId,
        activeCloudOrgId: state.activeCloudOrgId,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setTabsHydrated(true);
      },
    },
  ),
);
