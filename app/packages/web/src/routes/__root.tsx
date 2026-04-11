import { useState, useEffect } from "react";
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { DndShell, GlobalTabBar, useUIStore, useWorkspaceTabHandlers, workspaceTabTargetsEqual, dispatchResourcesChanged, type DraggableResource, type WorkspaceTab } from "@infrawrench/ui";
import { WebSidebar } from "@/components/WebSidebar";
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

interface AuthMe {
  userId: string;
  email: string;
  needsOnboarding: boolean;
}

function RootLayout() {
  const [authChecked, setAuthChecked] = useState(false);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    // Skip auth/onboarding check for public-ish routes
    if (pathname.startsWith("/onboarding") || pathname.startsWith("/invite/")) {
      // Still need auth check for these routes — but don't redirect to onboarding
      apiGet<AuthMe>("/api/auth/me")
        .then(() => setAuthChecked(true))
        .catch(() => { /* apiFetch redirects on 401 */ });
      return;
    }

    apiGet<AuthMe>("/api/auth/me")
      .then(async (me) => {
        if (me.needsOnboarding) {
          void navigate({ to: "/onboarding" });
          return;
        }

        // If not inside an org-scoped route, redirect to default org
        if (!pathname.startsWith("/org/")) {
          const orgs = await apiGet<Array<{ id: string }>>("/api/auth/orgs");
          if (orgs.length > 0) {
            void navigate({ to: "/org/$orgId", params: { orgId: orgs[0]!.id }, replace: true });
          }
          return;
        }

        setAuthChecked(true);
      })
      .catch(() => { /* apiFetch redirects on 401 */ });
  }, [navigate, pathname]);

  if (!authChecked) {
    // Allow onboarding and invite routes to render while auth is checked
    if (pathname.startsWith("/onboarding") || pathname.startsWith("/invite/")) {
      return <Outlet />;
    }

    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
        <div className="animate-pulse text-sm">Loading...</div>
      </div>
    );
  }

  // Onboarding and invite routes render without the shell
  if (pathname.startsWith("/onboarding") || pathname.startsWith("/invite/")) {
    return <Outlet />;
  }

  // If auth is confirmed but we're not on an org route yet, the redirect is
  // still in-flight — show the loading screen rather than the shell with
  // orgId=null (which would show "Select organization" in the org switcher).
  if (!pathname.startsWith("/org/")) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
        <div className="animate-pulse text-sm">Loading...</div>
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

  // Extract orgId from path for API calls
  const orgIdMatch = pathname.match(/^\/org\/([^/]+)/);
  const orgId = orgIdMatch?.[1] ? decodeURIComponent(orgIdMatch[1]) : null;

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

  useEffect(() => {
    if (!tabsHydrated || tabsValidated) return;
    const tabsSnapshot = useUIStore.getState().workspaceTabs;
    const activeIdSnapshot = useUIStore.getState().activeWorkspaceTabId;
    if (tabsSnapshot.length === 0) {
      setTabsValidated(true);
      return;
    }
    if (!orgId) {
      setTabsValidated(true);
      return;
    }

    let cancelled = false;
    apiPost<{ validTabIds: string[] }>(`/api/org/${orgId}/dashboards/validate-tabs`, {
      tabs: tabsSnapshot.map((t) => ({ id: t.id, target: t.target })),
    }).then(({ validTabIds }) => {
      if (cancelled) return;
      const validSet = new Set(validTabIds);
      const nextTabs = tabsSnapshot.filter((t) => validSet.has(t.id));
      replaceWorkspaceTabs(nextTabs, activeIdSnapshot);
      setTabsValidated(true);
    }).catch(() => {
      if (!cancelled) setTabsValidated(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsHydrated, tabsValidated, replaceWorkspaceTabs, orgId]);

  async function handleNewTab() {
    if (!orgId) return;
    try {
      const data = await apiGet<{ dashboard: { id: string; name: string } }>(`/api/org/${orgId}/dashboards/default/full`);
      const target = dashboardTabTarget(data.dashboard.id);
      createWorkspaceTabInstance(target, data.dashboard.name);
      void navigate({ to: "/org/$orgId", params: { orgId } });
    } catch {
      void navigate({ to: "/org/$orgId", params: { orgId } });
    }
  }

  async function handlePinToDashboard(resource: DraggableResource, dashboardId: string) {
    if (!orgId) return;
    await apiPost(`/api/org/${orgId}/dashboards/pin`, { dashboardId, resourceId: resource.id });
    useUIStore.getState().bumpDashboardPins();
    dispatchResourcesChanged();
  }

  return (
    <DndShell onPinToDashboard={handlePinToDashboard}>
      <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
        <GlobalTabBar
          tabs={workspaceTabs}
          activeTabId={activeWorkspaceTabId}
          onActivate={handleActivateTab}
          onClose={handleCloseTab}
          onNew={handleNewTab}
        />
        <div className="flex flex-1 overflow-hidden">
          <WebSidebar orgId={orgId} />
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
