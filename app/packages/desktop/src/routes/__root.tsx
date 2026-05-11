import { useCallback, useEffect, useState } from "react";
import {
  createRootRoute,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  DndShell,
  normalizeResourceId,
  resourceTabTitle,
  toast,
  useUIStore,
  useWorkspaceTabDocumentTitle,
  useWorkspaceTabHandlers,
  workspaceTabTargetsEqual,
  OrgSwitcher,
  type OrgEntry,
  type DraggableResource,
  type WorkspaceTab,
  type WorkspaceTabTarget,
} from "@infrawrench/ui";
import { AddAccountModal } from "../components/AddAccountModal";
import { GlobalTabBar } from "../components/GlobalTabBar";
import { SshHostKeyPromptHost } from "../components/SshHostKeyPromptHost";
import { SwipeIndicator } from "../components/SwipeIndicator";
import { SidebarAccounts } from "../components/SidebarAccounts";
import { SidebarDashboards } from "../components/SidebarDashboards";
import { getDb } from "../db/client";
import type { AccountRow } from "../db/rows";
import { pinResource } from "../lib/pins";
import { invoke } from "../lib/invoke";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { getPlugin } from "../plugins/loader";
import { useSwipeNavigation } from "../lib/useSwipeNavigation";
import { startMetricPinger } from "../lib/metric-pinger";
import {
  getCloudOrgs,
  getCloudAuthStatus,
  startCloudAuth,
  pinCloudResource,
  listCloudDashboards,
  type CloudOrg,
} from "../lib/cloud-api";
import {
  dashboardTabTarget,
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
  syncWorkspaceRouteFromPath,
} from "../lib/workspace-tabs";
import { SHOW_SIGN_IN_BUTTON } from "../../env";

export const Route = createRootRoute({
  component: RootLayout,
});

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

  const accountRows = await db.select<AccountRow[]>(
    "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1 LIMIT 1",
    [target.accountId],
  );
  const account = accountRows[0];
  if (!account) return null;

  try {
    const credentials = await invoke<Record<string, string>>("account_get_credentials", {
      accountId: account.id,
    });
    const loaded = await getPlugin(account.plugin_id);
    if (!loaded) return tab;
    const services = buildPluginHostServices(loaded.plugin.manifest, credentials);
    const client = loaded.plugin.createClient(credentials, services);
    const typeId = normalizeResourceId(target.resourceId).split(":")[1];
    if (!typeId) return tab;
    const resources = await client.listResources(typeId, account.id);
    const found = resources.find(
      (resource) => resource.id === normalizeResourceId(target.resourceId),
    );
    return found
      ? {
          ...tab,
          title: resourceTabTitle(found.displayName, target.view),
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
    reorderWorkspaceTabs,
    replaceWorkspaceTabs,
    setActiveDashboard,
    setActiveCloudOrgId,
  } = useUIStore();
  const navigate = useNavigate();

  const { handleActivateTab, handleCloseTab } = useWorkspaceTabHandlers(
    navigate,
    getWorkspaceNavigateArgs,
  );

  useWorkspaceTabDocumentTitle({ suffix: false });
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const hash = useRouterState({ select: (state) => state.location.hash });
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [tabsValidated, setTabsValidated] = useState(false);

  const [cloudOrgs, setCloudOrgs] = useState<CloudOrg[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(
    () => useUIStore.getState().activeCloudOrgId,
  );
  const [cloudAuthenticated, setCloudAuthenticated] = useState(false);

  useEffect(() => {
    setActiveCloudOrgId(activeOrgId);
  }, [activeOrgId, setActiveCloudOrgId]);

  useEffect(() => {
    startMetricPinger();
  }, []);

  useEffect(() => {
    getCloudAuthStatus()
      .then((status) => {
        setCloudAuthenticated(status.authenticated);
        if (status.authenticated) {
          getCloudOrgs()
            .then((orgs) => {
              setCloudOrgs(orgs);
              // Fall back to Local if the persisted org isn't reachable, or
              // the UI gets stuck on "Select organization".
              const current = useUIStore.getState().activeCloudOrgId;
              if (current && !orgs.some((o) => o.id === current)) {
                setActiveOrgId(null);
              }
            })
            .catch(console.error);
        } else {
          if (useUIStore.getState().activeCloudOrgId) setActiveOrgId(null);
        }
      })
      .catch((err) => {
        console.error(err);
        if (useUIStore.getState().activeCloudOrgId) setActiveOrgId(null);
      });
  }, []);

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
    // Preserves duplicate tab instances that share a target (e.g. multiple Home tabs).
    if (activeTab && workspaceTabTargetsEqual(activeTab.target, currentTarget)) return;
    syncWorkspaceRoute(currentTarget);
  }, [
    hash,
    pathname,
    activeWorkspaceTabId,
    setActiveDashboard,
    syncWorkspaceRoute,
    tabsHydrated,
    workspaceTabs,
  ]);

  useEffect(() => {
    if (!tabsHydrated || tabsValidated) return;
    let cancelled = false;

    // Snapshot at hydration time — workspaceTabs and activeWorkspaceTabId are
    // intentionally excluded from deps so this runs only once.
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
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceWorkspaceTabs, tabsHydrated, tabsValidated]);

  useEffect(() => {
    if (!tabsHydrated || pathname !== "/") return;
    const activeTab =
      workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? workspaceTabs[0];
    if (!activeTab) return;
    void navigate(getWorkspaceNavigateArgs(activeTab.target, true));
  }, [activeWorkspaceTabId, navigate, pathname, tabsHydrated, workspaceTabs]);

  async function handlePinToDashboard(resource: DraggableResource, dashboardId: string) {
    const orgId = useUIStore.getState().activeCloudOrgId;
    let dashLabel: string | undefined;
    if (orgId) {
      await pinCloudResource(orgId, dashboardId, resource.id);
      const list = await listCloudDashboards(orgId).catch(() => []);
      dashLabel = list.find((d) => d.id === dashboardId)?.name;
    } else {
      const db = await getDb();
      await pinResource(resource, db, dashboardId);
      const dashRows = await db.select<{ name: string }[]>(
        "SELECT name FROM dashboards WHERE id = $1 LIMIT 1",
        [dashboardId],
      );
      dashLabel = dashRows[0]?.name;
    }
    bumpDashboardPins();
    void navigateToWorkspaceTarget(
      navigate,
      dashboardTabTarget(dashboardId),
      dashLabel ? { label: dashLabel } : undefined,
    );
  }

  function handleSecretDrop(
    source: DraggableResource,
    targetId: string,
    kind: "account" | "resource",
  ) {
    window.dispatchEvent(
      new CustomEvent("iw:sidebar-secret-drop", {
        detail: { source, targetId, kind },
      }),
    );
  }

  function handleResourceAttach(source: DraggableResource, target: DraggableResource) {
    window.dispatchEvent(
      new CustomEvent("iw:resource-attach", {
        detail: { source, target },
      }),
    );
  }

  function handleTabDrop(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    const activeData = active.data.current;
    const workspaceTabId = activeData?.workspaceTabId as string | undefined;
    const workspaceTabTarget = activeData?.workspaceTabTarget as WorkspaceTabTarget | undefined;
    const dragLabel = activeData?.dragLabel as string | undefined;

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

  async function handleSwitchOrg(orgId: string | null) {
    setActiveOrgId(orgId);
    try {
      if (orgId) {
        const list = await listCloudDashboards(orgId);
        const first = list.find((d) => d.isDefault) ?? list[0];
        if (!first) return;
        void navigateToWorkspaceTarget(navigate, dashboardTabTarget(first.id), {
          label: first.name,
        });
      } else {
        const db = await getDb();
        const rows = await db.select<{ id: string; name: string }[]>(
          "SELECT id, name FROM dashboards ORDER BY is_default DESC, name ASC LIMIT 1",
        );
        const first = rows[0];
        if (!first) return;
        void navigateToWorkspaceTarget(navigate, dashboardTabTarget(first.id), {
          label: first.name,
        });
      }
    } catch (e) {
      console.error("[org-switch] failed to navigate to first dashboard:", e);
      toast.error("Couldn't switch organization", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <DndShell
      onPinToDashboard={(r, d) => {
        void handlePinToDashboard(r, d);
      }}
      onSecretDrop={handleSecretDrop}
      onResourceAttach={handleResourceAttach}
      onTabDrop={handleTabDrop}
    >
      <div className="flex flex-col h-screen bg-surface text-on-surface select-none">
        {/* macOS drag region — children must opt out individually. */}
        <div
          className="h-8 flex-shrink-0 border-b border-border/50 flex items-center"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <div
            className="flex items-center gap-0.5 pl-20"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <button
              onClick={() => router.history.back()}
              className="w-6 h-6 flex items-center justify-center rounded text-on-surface-tertiary hover:text-on-surface hover:bg-surface-sunken transition-colors text-base leading-none font-medium"
              aria-label="Go back"
            >
              ‹
            </button>
            <button
              onClick={() => router.history.forward()}
              className="w-6 h-6 flex items-center justify-center rounded text-on-surface-tertiary hover:text-on-surface hover:bg-surface-sunken transition-colors text-base leading-none font-medium"
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
          onNew={() => {
            void handleNewTab();
          }}
        />

        <div className="flex flex-1 overflow-hidden">
          {!sidebarCollapsed && (
            <aside className="w-60 border-r border-border flex flex-col overflow-hidden flex-shrink-0">
              <div className="flex items-center justify-between px-1 py-1 border-b border-border">
                <div
                  className="flex-1 min-w-0"
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                >
                  <OrgSwitcher
                    orgs={cloudOrgs}
                    activeOrgId={activeOrgId}
                    onSwitch={(orgId) => {
                      void handleSwitchOrg(orgId);
                    }}
                    showLocalOption
                  />
                </div>
                <button
                  onClick={toggleSidebar}
                  className="text-on-surface-faint hover:text-on-surface-tertiary transition-colors text-xs px-2"
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                  aria-label="Collapse sidebar"
                >
                  &#9664;
                </button>
              </div>

              <div className="flex-1 overflow-y-auto py-2">
                <SidebarDashboards />
                <SidebarAccounts refreshKey={accountsVersion} />
              </div>

              <div className="border-t border-border p-2">
                <button
                  onClick={() => setShowAddAccount(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
                >
                  <span className="text-base leading-none">+</span>
                  Add account
                </button>
                {SHOW_SIGN_IN_BUTTON && !cloudAuthenticated && (
                  <button
                    onClick={() => {
                      void startCloudAuth().then(() => {
                        const poll = setInterval(() => {
                          getCloudAuthStatus()
                            .then((status) => {
                              if (status.authenticated) {
                                setCloudAuthenticated(true);
                                getCloudOrgs().then(setCloudOrgs).catch(console.error);
                                clearInterval(poll);
                              }
                            })
                            .catch(console.error);
                        }, 2000);
                        setTimeout(() => clearInterval(poll), 120_000);
                      });
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
                  >
                    <span className="text-base leading-none">&#9729;</span>
                    Sign in to cloud
                  </button>
                )}
              </div>
            </aside>
          )}

          {sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              className="w-8 border-r border-border flex items-center justify-center text-on-surface-faint hover:text-on-surface-tertiary transition-colors flex-shrink-0"
              aria-label="Expand sidebar"
            >
              ▶
            </button>
          )}

          <main className="flex-1 overflow-hidden">
            <Outlet />
          </main>

          {showAddAccount && (
            <AddAccountModal
              onClose={() => setShowAddAccount(false)}
              onAdded={() => bumpAccounts()}
              orgId={activeOrgId}
            />
          )}
        </div>
      </div>

      <SwipeIndicator gesture={swipeGesture} />
      <SshHostKeyPromptHost />
    </DndShell>
  );
}
