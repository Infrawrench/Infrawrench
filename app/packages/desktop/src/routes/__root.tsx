import { useEffect, useState } from "react";
import { createRootRoute, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { getWorkspaceTabId, normalizeResourceId, useUIStore, type WorkspaceTab, type WorkspaceTabTarget } from "@infrawrench/ui";
import { AddAccountModal } from "../components/AddAccountModal";
import { GlobalTabBar } from "../components/GlobalTabBar";
import { SidebarAccounts } from "../components/SidebarAccounts";
import { SidebarDashboards } from "../components/SidebarDashboards";
import { getDb } from "../db/client";
import { pinResource, type DraggableResource } from "../lib/pins";
import { invoke } from "../lib/invoke";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { getPlugin } from "../plugins/loader";
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
          title: target.view === "ssh" ? `SSH: ${found.displayName}` : found.displayName,
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

  useEffect(() => {
    if (!tabsHydrated) return;
    const currentTarget = syncWorkspaceRouteFromPath(pathname, hash);
    if (!currentTarget) {
      setActiveDashboard(null);
      return;
    }
    setActiveDashboard(currentTarget.kind === "dashboard" ? currentTarget.dashboardId : null);
    // Skip sync if the active tab already matches the current URL — this prevents
    // syncWorkspaceRoute (reuse-active) from replacing a pinned tab that was just
    // set as active by pinWorkspaceTab right before navigate() was called.
    if (activeWorkspaceTabId === getWorkspaceTabId(currentTarget)) return;
    syncWorkspaceRoute(currentTarget);
  }, [hash, pathname, activeWorkspaceTabId, setActiveDashboard, syncWorkspaceRoute, tabsHydrated]);

  useEffect(() => {
    if (!tabsHydrated || tabsValidated) return;
    let cancelled = false;

    async function validateTabs() {
      const validated = await Promise.all(workspaceTabs.map((tab) => validateWorkspaceTab(tab)));
      if (cancelled) return;
      const nextTabs = validated.filter((tab): tab is WorkspaceTab => !!tab);
      replaceWorkspaceTabs(nextTabs, activeWorkspaceTabId);
      setTabsValidated(true);
    }

    void validateTabs();
    return () => { cancelled = true; };
  }, [activeWorkspaceTabId, replaceWorkspaceTabs, tabsHydrated, tabsValidated, workspaceTabs]);

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
    void navigateToWorkspaceTarget(navigate, dashboardTabTarget(dashboardId));
  }

  function handleActivateTab(tabId: string) {
    const tab = workspaceTabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    activateWorkspaceTab(tabId);
    void navigate(getWorkspaceNavigateArgs(tab.target));
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
    </DndContext>
  );
}
