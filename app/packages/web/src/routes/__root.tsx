import { useState, useEffect } from "react";
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { DndShell, useUIStore, useWorkspaceTabHandlers, workspaceTabTargetsEqual, dispatchResourcesChanged, type DraggableResource, type WorkspaceTab } from "@infrawrench/ui";
import { WebSidebar } from "@/components/WebSidebar";
import { WebGlobalTabBar } from "@/components/WebGlobalTabBar";
import { SpotlightSearch } from "@/components/SpotlightSearch";
import { apiGet, apiPost } from "@/lib/api";
import {
  dashboardTabTarget,
  getWorkspaceNavigateArgs,
  syncWorkspaceRouteFromPath,
} from "@/lib/workspace-tabs";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    // Auth check — on 401 the api client auto-redirects to sign-in
    apiGet("/api/auth/me")
      .then(() => setAuthChecked(true))
      .catch(() => {
        // apiFetch already redirects on 401
      });
  }, []);

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
        <div className="animate-pulse text-sm">Loading…</div>
      </div>
    );
  }

  return <AuthenticatedShell />;
}

function AuthenticatedShell() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [tabsValidated, setTabsValidated] = useState(false);

  // ⌘K / Ctrl+K to open spotlight search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSpotlightOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const {
    workspaceTabs,
    activeWorkspaceTabId,
    tabsHydrated,
    syncWorkspaceRoute,
    createWorkspaceTabInstance,
    replaceWorkspaceTabs,
    setActiveDashboard,
  } = useUIStore();

  const { handleActivateTab, handleCloseTab } = useWorkspaceTabHandlers(navigate, getWorkspaceNavigateArgs);

  // Sync route changes → workspace tabs
  useEffect(() => {
    if (!tabsHydrated) return;
    const currentTarget = syncWorkspaceRouteFromPath(pathname, hash);
    if (!currentTarget) {
      setActiveDashboard(null);
      return;
    }
    setActiveDashboard(currentTarget.kind === "dashboard" ? currentTarget.dashboardId : null);
    const activeTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
    if (activeTab && workspaceTabTargetsEqual(activeTab.target, currentTarget)) return;
    syncWorkspaceRoute(currentTarget);
  }, [hash, pathname, activeWorkspaceTabId, setActiveDashboard, syncWorkspaceRoute, tabsHydrated, workspaceTabs]);

  // Validate persisted tabs on first hydration — prune stale references
  useEffect(() => {
    if (!tabsHydrated || tabsValidated) return;
    const tabsSnapshot = useUIStore.getState().workspaceTabs;
    const activeIdSnapshot = useUIStore.getState().activeWorkspaceTabId;
    if (tabsSnapshot.length === 0) {
      setTabsValidated(true);
      return;
    }

    let cancelled = false;
    apiPost<{ validTabIds: string[] }>("/api/dashboards/validate-tabs", {
      tabs: tabsSnapshot.map((t) => ({ id: t.id, target: t.target })),
    }).then(({ validTabIds }) => {
      if (cancelled) return;
      const validSet = new Set(validTabIds);
      const nextTabs = tabsSnapshot.filter((t) => validSet.has(t.id));
      replaceWorkspaceTabs(nextTabs, activeIdSnapshot);
      setTabsValidated(true);
    }).catch(() => {
      // On failure, keep all tabs rather than losing them
      if (!cancelled) setTabsValidated(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsHydrated, tabsValidated, replaceWorkspaceTabs]);

  async function handleNewTab() {
    try {
      const data = await apiGet<{ dashboard: { id: string; name: string } }>("/api/dashboards/default/full");
      const target = dashboardTabTarget(data.dashboard.id);
      createWorkspaceTabInstance(target, data.dashboard.name);
      void navigate({ to: "/" });
    } catch {
      void navigate({ to: "/" });
    }
  }

  async function handlePinToDashboard(resource: DraggableResource, dashboardId: string) {
    await apiPost("/api/dashboards/pin", { dashboardId, resourceId: resource.id });
    useUIStore.getState().bumpDashboardPins();
    dispatchResourcesChanged();
  }

  return (
    <DndShell onPinToDashboard={handlePinToDashboard}>
      <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
        <WebGlobalTabBar
          tabs={workspaceTabs}
          activeTabId={activeWorkspaceTabId}
          onActivate={handleActivateTab}
          onClose={handleCloseTab}
          onNew={handleNewTab}
        />
        <div className="flex flex-1 overflow-hidden">
          <WebSidebar />
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
        </div>
      </div>
      {spotlightOpen && (
        <SpotlightSearch
          mode="navigate"
          onClose={() => setSpotlightOpen(false)}
        />
      )}
    </DndShell>
  );
}
