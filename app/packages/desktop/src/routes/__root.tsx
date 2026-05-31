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
  TunnelSshAttachModal,
  useUIStore,
  useWorkspaceTabDocumentTitle,
  useWorkspaceTabHandlers,
  workspaceTabTargetsEqual,
  OrgSwitcher,
  type OrgEntry,
  type DraggableResource,
  type DraggableWorkflow,
  type TunnelSshAttachZone,
  type TunnelSshAttachKey,
  type WorkspaceTab,
  type WorkspaceTabTarget,
} from "@infrawrench/ui";
import { AddAccountModal } from "../components/AddAccountModal";
import { GlobalTabBar } from "../components/GlobalTabBar";
import { DesktopWorkspaceTabsViewport } from "../components/WorkspaceTabsViewport";
import { SshHostKeyPromptHost } from "../components/SshHostKeyPromptHost";
import { WorkflowPromptHost } from "../components/WorkflowPromptHost";
import { SpotlightSearch } from "../components/SpotlightSearch";
import { UpdatePromptHost } from "../components/UpdatePromptHost";
import { SwipeIndicator } from "../components/SwipeIndicator";
import { SidebarAccounts } from "../components/SidebarAccounts";
import { SidebarDashboards } from "../components/SidebarDashboards";
import { getDb } from "../db/client";
import type { AccountRow } from "../db/rows";
import { pinResource, pinWorkflow } from "../lib/pins";
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
  resourceTabTarget,
  workflowsTabTarget,
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
  syncWorkspaceRouteFromPath,
} from "../lib/workspace-tabs";
import { BANNERS, SHOW_SIGN_IN_BUTTON } from "../../env";

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

  // Workflows tabs aren't backed by a DB row; keep them as-is.
  if (target.kind === "workflows") {
    return tab;
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
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [tabsValidated, setTabsValidated] = useState(false);
  const [tunnelAttach, setTunnelAttach] = useState<{
    tunnel: DraggableResource;
    host: DraggableResource;
    zones: TunnelSshAttachZone[];
    sshKeys: TunnelSshAttachKey[];
    defaultUsername: string;
  } | null>(null);

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

  // Global Cmd/Ctrl+K opens the spotlight (navigate) from any tab — dashboards,
  // the Workflows tab, resource detail, etc.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSpotlightOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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

  async function handlePinWorkflowToDashboard(workflow: DraggableWorkflow, dashboardId: string) {
    // Workflows live in the local DB; a cloud dashboard can't reference them.
    if (useUIStore.getState().activeCloudOrgId) {
      toast.error("Switch to Local to pin workflows", {
        description: "Workflows are stored locally and can only be pinned to local dashboards.",
      });
      return;
    }
    const db = await getDb();
    await pinWorkflow(workflow.id, dashboardId, db);
    bumpDashboardPins();
  }

  async function handleTunnelSshAttach(tunnel: DraggableResource, host: DraggableResource) {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) {
      toast.error("Set up SSH over tunnel runs through the cloud", {
        description: "Sign in to an organization to use this.",
      });
      return;
    }
    try {
      const { getCloudCreateConfig, cloudListSshKeys } = await import("../lib/cloud-resources");
      const [config, keys] = await Promise.all([
        getCloudCreateConfig(orgId, tunnel.accountId, "dns-record", "cloudflare") as Promise<{
          fields?: Array<{ key: string; options?: { id: string; label: string }[] }>;
        }>,
        cloudListSshKeys(orgId),
      ]);
      const zones: TunnelSshAttachZone[] = (
        config.fields?.find((f) => f.key === "zoneId")?.options ?? []
      ).map((o) => ({ id: o.id, label: o.label }));
      const sshKeys: TunnelSshAttachKey[] = (keys ?? []).map((k) => ({ id: k.id, label: k.name }));
      setTunnelAttach({
        tunnel,
        host,
        zones,
        sshKeys,
        defaultUsername: String(host.fields["sshUsername"] ?? "root"),
      });
    } catch (e) {
      toast.error("Couldn't start SSH tunnel setup", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
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
      onPinWorkflowToDashboard={(w, d) => {
        void handlePinWorkflowToDashboard(w, d);
      }}
      onSecretDrop={handleSecretDrop}
      onResourceAttach={handleResourceAttach}
      onTunnelSshAttach={(t, h) => void handleTunnelSshAttach(t, h)}
      onTabDrop={handleTabDrop}
    >
      <div className="flex flex-col h-screen bg-surface text-on-surface select-none">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-1.5 focus:rounded focus:bg-surface-overlay focus:text-on-surface focus:border focus:border-border-strong focus:shadow-lg"
        >
          Skip to content
        </a>
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
              type="button"
              onClick={() => router.history.back()}
              className="size-6 flex items-center justify-center rounded text-on-surface-tertiary hover:text-on-surface hover:bg-surface-sunken transition-colors text-base leading-none font-medium"
              aria-label="Go back"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => router.history.forward()}
              className="size-6 flex items-center justify-center rounded text-on-surface-tertiary hover:text-on-surface hover:bg-surface-sunken transition-colors text-base leading-none font-medium"
              aria-label="Go forward"
            >
              ›
            </button>
          </div>
        </div>

        {BANNERS.length > 0 && (
          <div className="flex-shrink-0 flex flex-col">
            {BANNERS.map((banner) => (
              <div
                key={banner.message}
                className={`px-3 py-1.5 text-xs text-center border-b ${
                  banner.variant === "warning"
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30"
                    : "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30"
                }`}
              >
                {banner.message}
              </div>
            ))}
          </div>
        )}

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
              <div className="flex items-center justify-between p-1 border-b border-border">
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
                  type="button"
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
                  type="button"
                  onClick={() => setShowAddAccount(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
                >
                  <span className="text-base leading-none">+</span>
                  Add account
                </button>
                {SHOW_SIGN_IN_BUTTON && !cloudAuthenticated && (
                  <button
                    type="button"
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
              type="button"
              onClick={toggleSidebar}
              className="w-8 border-r border-border flex items-center justify-center text-on-surface-faint hover:text-on-surface-tertiary transition-colors flex-shrink-0"
              aria-label="Expand sidebar"
            >
              ▶
            </button>
          )}

          <main id="main-content" className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Tabs render via WorkspaceTabsViewport: every open tab stays
                mounted so SSH PTYs / xterm scrollback / port-forwards
                survive tab switches. <Outlet/> still renders non-tab routes
                (index, settings); tab routes' components are no-ops. */}
            <DesktopWorkspaceTabsViewport />
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

      {spotlightOpen && (
        <SpotlightSearch
          mode="navigate"
          onClose={() => setSpotlightOpen(false)}
          onNavigate={(result) => {
            setSpotlightOpen(false);
            if (result.resourceTypeId === "__workflow__") {
              void navigateToWorkspaceTarget(navigate, workflowsTabTarget(), {
                label: "Workflows",
              });
            } else {
              void navigateToWorkspaceTarget(
                navigate,
                resourceTabTarget(result.accountId, result.id),
                { label: result.displayName },
              );
            }
          }}
        />
      )}

      <SwipeIndicator gesture={swipeGesture} />
      <SshHostKeyPromptHost />
      <WorkflowPromptHost />
      <UpdatePromptHost />
      {tunnelAttach && (
        <TunnelSshAttachModal
          tunnelName={tunnelAttach.tunnel.displayName}
          hostName={tunnelAttach.host.displayName}
          zones={tunnelAttach.zones}
          sshKeys={tunnelAttach.sshKeys}
          showSshKeyPicker
          defaultUsername={tunnelAttach.defaultUsername}
          onClose={() => setTunnelAttach(null)}
          onRun={async (params) => {
            const orgId = useUIStore.getState().activeCloudOrgId;
            if (!orgId) throw new Error("Not signed in to an organization");
            const { cloudTunnelSshAttach } = await import("../lib/cloud-resources");
            return cloudTunnelSshAttach(orgId, {
              tunnel: {
                accountId: tunnelAttach.tunnel.accountId,
                pluginId: tunnelAttach.tunnel.pluginId,
                resourceId: tunnelAttach.tunnel.id,
              },
              host: {
                accountId: tunnelAttach.host.accountId,
                pluginId: tunnelAttach.host.pluginId,
                resourceTypeId: tunnelAttach.host.resourceTypeId,
                resourceId: tunnelAttach.host.id,
              },
              ...params,
            });
          }}
        />
      )}
    </DndShell>
  );
}
