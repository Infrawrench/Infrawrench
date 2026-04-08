import { useCallback, useEffect, useState } from "react";
import { createRootRoute, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { normalizeResourceId, useUIStore, workspaceTabTargetsEqual, type WorkspaceTab, type WorkspaceTabTarget } from "@infrawrench/ui";
import { AddAccountModal } from "../components/AddAccountModal";
import { GlobalTabBar } from "../components/GlobalTabBar";
import { SwipeIndicator } from "../components/SwipeIndicator";
import { SidebarAccounts } from "../components/SidebarAccounts";
import { SidebarDashboards } from "../components/SidebarDashboards";
import { getDb } from "../db/client";
import { pinResource, type DraggableResource } from "../lib/pins";
import { invoke } from "../lib/invoke";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { getPlugin } from "../plugins/loader";
import { useSwipeNavigation } from "../lib/useSwipeNavigation";
import {
  dashboardTabTarget,
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
  syncWorkspaceRouteFromPath,
} from "../lib/workspace-tabs";

export const Route = createRootRoute({
  component: RootLayout,
});

interface AccountValidationRow {
  id: string;
  plugin_id: string;
  display_name: string;
  encrypted_credentials: string;
  credentials_iv: string;
}

async function validateWorkspaceTab(tab: WorkspaceTab): Promise<WorkspaceTab | null> {
  const db = await getDb();
  const target = tab.target;

  if (target.kind === "dashboard") {
    const rows = await db.select<{ name: string }[]>(
      "SELECT name FROM dashboards WHERE id = $1 LIMIT 1",
      [target.dashboardId],
    );
    return rows[0] ? { ...tab, title: rows[0].name } : null;
  }

  if (target.kind === "account") {
    const rows = await db.select<{ display_name: string }[]>(
      "SELECT display_name FROM accounts WHERE id = $1 LIMIT 1",
      [target.accountId],
    );
    return rows[0] ? { ...tab, title: rows[0].display_name } : null;
  }

  const accountRows = await db.select<AccountValidationRow[]>(
    "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1 LIMIT 1",
    [target.accountId],
  );
  const account = accountRows[0];
  if (!account) return null;

  try {
    const plaintext = await invoke<string>("decrypt_value", {
      ciphertext: account.encrypted_credentials,
      iv: account.credentials_iv,
    });
    const credentials = JSON.parse(plaintext) as Record<string, string>;
    const loaded = await getPlugin(account.plugin_id);
    if (!loaded) return tab;
    const services = buildPluginHostServices(loaded.plugin.manifest, credentials);
    const client = loaded.plugin.createClient(credentials, services);
    const typeId = normalizeResourceId(target.resourceId).split(":")[1];
    if (!typeId) return tab;
    const resources = await client.listResources(typeId, account.id);
    const found = resources.find((resource) => resource.id === normalizeResourceId(target.resourceId));
    return found
      ? {
          ...tab,
          title: target.view === "ssh" ? `SSH: ${found.displayName}` : target.view === "sftp" ? `SFTP: ${found.displayName}` : found.displayName,
          target: {
            kind: "resource",
            accountId: target.accountId,
            resourceId: normalizeResourceId(found.id),
            view: target.view ?? "details",
          },
        }
      : null;
  } catch {
    return tab;
  }
}

function RootLayout() {
  const {
    sidebarCollapsed,
    toggleSidebar,
    bumpDashboardPins,
    accountsVersion,
    bumpAccounts,
    workspaceTabs,
    activeWorkspaceTabId,
    tabsHydrated,
    createWorkspaceTabInstance,
    syncWorkspaceRoute,
    activateWorkspaceTab,
    closeWorkspaceTab,
    reorderWorkspaceTabs,
    replaceWorkspaceTabs,
    setActiveDashboard,
  } = useUIStore();
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const hash = useRouterState({ select: (state) => state.location.hash });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [dragPreview, setDragPreview] = useState<string | null>(null);
  const [tabsValidated, setTabsValidated] = useState(false);

  // Trackpad swipe gesture → browser-style back/forward
  const swipeBack = useCallback(() => router.history.back(), [router]);
  const swipeForward = useCallback(() => router.history.forward(), [router]);
  const swipeGesture = useSwipeNavigation(swipeBack, swipeForward);

  useEffect(() => {
    if (!tabsHydrated) return;
    const currentTarget = syncWorkspaceRouteFromPath(pathname, hash);
    if (!currentTarget) {
      setActiveDashboard(null);
      return;
    }
    setActiveDashboard(currentTarget.kind === "dashboard" ? currentTarget.dashboardId : null);
    const activeTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
    // Skip sync if the active tab already points at the current URL. This preserves
    // duplicate tab instances that share a target, such as multiple Home tabs.
    if (activeTab && workspaceTabTargetsEqual(activeTab.target, currentTarget)) return;
    syncWorkspaceRoute(currentTarget);
  }, [hash, pathname, activeWorkspaceTabId, setActiveDashboard, syncWorkspaceRoute, tabsHydrated, workspaceTabs]);

  useEffect(() => {
    if (!tabsHydrated || tabsValidated) return;
    let cancelled = false;

    // Capture current tabs/activeId at hydration time — we deliberately exclude
    // workspaceTabs and activeWorkspaceTabId from deps so this only runs once.
    const tabsSnapshot = useUIStore.getState().workspaceTabs;
    const activeIdSnapshot = useUIStore.getState().activeWorkspaceTabId;

    async function validateTabs() {
      const validated = await Promise.all(tabsSnapshot.map((tab) => validateWorkspaceTab(tab)));
      if (cancelled) return;
      const nextTabs = validated.filter((tab): tab is WorkspaceTab => !!tab);
      replaceWorkspaceTabs(nextTabs, activeIdSnapshot);
      setTabsValidated(true);
    }

    void validateTabs();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceWorkspaceTabs, tabsHydrated, tabsValidated]);

  useEffect(() => {
    if (!tabsHydrated || pathname !== "/") return;
    const activeTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? workspaceTabs[0];
    if (!activeTab) return;
    void navigate(getWorkspaceNavigateArgs(activeTab.target, true));
  }, [activeWorkspaceTabId, navigate, pathname, tabsHydrated, workspaceTabs]);

  async function handleDragEnd(event: DragEndEvent) {
    setDragPreview(null);
    const { active, over } = event;
    if (!over) return;
    const activeData = active.data.current;
    const overId = String(over.id);
    const workspaceTabId = activeData?.workspaceTabId as string | undefined;
    const workspaceTabTarget = activeData?.workspaceTabTarget as WorkspaceTabTarget | undefined;
    const dragLabel = activeData?.dragLabel as string | undefined;

    if (overId === "global-tabs-bar" || overId.startsWith("global-tab:")) {
      if (workspaceTabId) {
        const overTabId = overId.startsWith("global-tab:") ? overId.replace("global-tab:", "") : null;
        if (overTabId) reorderWorkspaceTabs(workspaceTabId, overTabId);
        return;
      }
      if (workspaceTabTarget) {
        void navigateToWorkspaceTarget(
          navigate,
          workspaceTabTarget,
          dragLabel ? { label: dragLabel, mode: "pin" } : { mode: "pin" },
        );
      }
      return;
    }

    // Secret import drops are handled directly by PeerPaneView via useDndMonitor
    if (overId.startsWith("secret-import:")) return;

    // Sidebar account/resource drops — dispatch event for SidebarAccounts to handle
    if (overId.startsWith("sidebar-account:") || overId.startsWith("sidebar-resource:")) {
      const resource = activeData?.resource as DraggableResource | undefined;
      if (!resource) return;
      const targetId = overId.startsWith("sidebar-account:")
        ? overId.replace("sidebar-account:", "")
        : overId.replace("sidebar-resource:", "");
      // Ignore self-drops (dragged element's own droppable following the pointer)
      if (resource.id === targetId) return;
      const kind = overId.startsWith("sidebar-account:") ? "account" : "resource";
      window.dispatchEvent(new CustomEvent("iw:sidebar-secret-drop", {
        detail: { source: resource, targetId, kind },
      }));
      return;
    }

    let dashboardId: string | null = null;
    if (overId.startsWith("sidebar-dashboard:")) {
      dashboardId = overId.replace("sidebar-dashboard:", "");
    } else if (overId.startsWith("dashboard:")) {
      dashboardId = overId.replace("dashboard:", "");
    }
    if (!dashboardId) return;

    const resource = activeData?.resource as DraggableResource | undefined;
    if (!resource) return;
    const db = await getDb();
    await pinResource(resource, db, dashboardId);
    bumpDashboardPins();
    const dashRows = await db.select<{ name: string }[]>(
      "SELECT name FROM dashboards WHERE id = $1 LIMIT 1",
      [dashboardId],
    );
    const dashLabel = dashRows[0]?.name;
    void navigateToWorkspaceTarget(
      navigate,
      dashboardTabTarget(dashboardId),
      dashLabel ? { label: dashLabel } : undefined,
    );
  }

  function handleActivateTab(tabId: string) {
    const tab = workspaceTabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    activateWorkspaceTab(tabId);
    void navigate(getWorkspaceNavigateArgs(tab.target));
  }

  async function handleNewTab() {
    const db = await getDb();
    const rows = await db.select<{ id: string }[]>(
      "SELECT id FROM dashboards WHERE is_default = 1 LIMIT 1",
    );
    const homeId = rows[0]?.id ?? "dashboard-home";
    const target = dashboardTabTarget(homeId);
    createWorkspaceTabInstance(target, "Home");
    void navigate(getWorkspaceNavigateArgs(target));
  }

  function handleCloseTab(tabId: string) {
    const wasActive = activeWorkspaceTabId === tabId;
    closeWorkspaceTab(tabId);
    if (!wasActive) return;
    const nextState = useUIStore.getState();
    const nextTab = nextState.workspaceTabs.find((tab) => tab.id === nextState.activeWorkspaceTabId);
    if (nextTab) {
      void navigate(getWorkspaceNavigateArgs(nextTab.target, true));
    } else {
      void navigate({ to: "/", replace: true });
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={(e) => {
        const preview = e.active.data.current?.dragLabel as string | undefined;
        const resource = e.active.data.current?.resource as DraggableResource | undefined;
        setDragPreview(preview ?? resource?.displayName ?? null);
      }}
      onDragEnd={(e) => { void handleDragEnd(e); }}
      onDragCancel={() => setDragPreview(null)}
    >
      <div className="flex flex-col h-screen bg-gray-950 text-gray-100 select-none">
        {/* macOS title bar — drag region with back/forward buttons */}
        <div
          className="h-8 flex-shrink-0 border-b border-gray-800/50 flex items-center"
          style={{ WebkitAppRegion: dragPreview ? "no-drag" : "drag" } as React.CSSProperties}
        >
          {/* Buttons must opt out of drag region */}
          <div
            className="flex items-center gap-0.5 pl-20"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <button
              onClick={() => router.history.back()}
              className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700 transition-colors text-base leading-none font-medium"
              aria-label="Go back"
            >
              ‹
            </button>
            <button
              onClick={() => router.history.forward()}
              className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700 transition-colors text-base leading-none font-medium"
              aria-label="Go forward"
            >
              ›
            </button>
          </div>
        </div>

        <GlobalTabBar
          tabs={workspaceTabs}
          activeTabId={activeWorkspaceTabId}
          onActivate={handleActivateTab}
          onClose={handleCloseTab}
          onNew={() => { void handleNewTab(); }}
        />

        <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {!sidebarCollapsed && (
          <aside className="w-60 border-r border-gray-800 flex flex-col overflow-hidden flex-shrink-0">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
              <span className="text-sm font-semibold text-gray-300">Infrawrench</span>
              <button
                onClick={toggleSidebar}
                className="text-gray-700 hover:text-gray-400 transition-colors text-xs"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                aria-label="Collapse sidebar"
              >
                ◀
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-2">
              <SidebarDashboards />
              <SidebarAccounts refreshKey={accountsVersion} />
            </div>

            {/* Add account button pinned to the bottom */}
            <div className="border-t border-gray-800 p-2">
              <button
                onClick={() => setShowAddAccount(true)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
              >
                <span className="text-base leading-none">+</span>
                Add account
              </button>
            </div>
          </aside>
        )}

        {/* Expand toggle when collapsed */}
        {sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            className="w-8 border-r border-gray-800 flex items-center justify-center text-gray-700 hover:text-gray-400 transition-colors flex-shrink-0"
            aria-label="Expand sidebar"
          >
            ▶
          </button>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-hidden">
          <Outlet />
        </main>

        {/* Add account modal */}
        {showAddAccount && (
          <AddAccountModal
            onClose={() => setShowAddAccount(false)}
            onAdded={() => bumpAccounts()}
          />
        )}
        </div>{/* end flex row */}
      </div>

      {/* Floating drag preview */}
      <DragOverlay>
        {dragPreview && (
          <div className="px-3 py-1.5 rounded-full border border-blue-500 bg-gray-900 text-sm font-medium text-gray-200 shadow-lg cursor-grabbing opacity-90">
            {dragPreview}
          </div>
        )}
      </DragOverlay>

      {/* Trackpad swipe navigation indicator */}
      <SwipeIndicator gesture={swipeGesture} />
    </DndContext>
  );
}
