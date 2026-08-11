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
  getWorkspaceTabFallbackTitle,
  normalizeResourceId,
  resourceTabTitle,
  toast,
  TunnelSshAttachModal,
  useUIStore,
  useWorkspaceTabDocumentTitle,
  useWorkspaceTabHandlers,
  workspaceTabTargetsEqual,
  OrgSwitcher,
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
import { PromptHost } from "@infrawrench/ui/workflows";
import { SpotlightSearch } from "../components/SpotlightSearch";
import { UpdatePromptHost } from "../components/UpdatePromptHost";
import { SwipeIndicator } from "../components/SwipeIndicator";
import { SidebarAccounts } from "../components/SidebarAccounts";
import { ProviderIncidentShellBanner } from "../components/ProviderIncidentShellBanner";
import { SidebarDashboards } from "../components/SidebarDashboards";
import { Onboarding, isOnboardingComplete, markOnboardingComplete } from "../components/Onboarding";
import { getDb } from "../db/client";
import type { AccountRow } from "../db/rows";
import { pinResource, pinWorkflow } from "../lib/pins";
import { invoke } from "../lib/invoke";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { getPlugin } from "../plugins/loader";
import { useSwipeNavigation } from "../lib/useSwipeNavigation";
import { startMetricPinger } from "../lib/metric-pinger";
import { startCronRunner } from "../lib/cron-runner";
import {
  getCloudOrgs,
  getCloudAuthStatus,
  startCloudAuth,
  pinCloudResource,
  pinCloudWorkflow,
  listCloudDashboards,
  validateCloudWorkspaceTabs as validateCloudTabs,
  type CloudOrg,
} from "../lib/cloud-api";
import {
  dashboardTabTarget,
  resourceTabTarget,
  workflowsTabTarget,
  settingsTabTarget,
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
  plainRouteDocumentTitle,
  syncWorkspaceRouteFromPath,
} from "../lib/workspace-tabs";
import { BANNERS, SHOW_SIGN_IN_BUTTON } from "../../env";

export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * Cloud tabs point at rows that live in the org, not in the local database, so
 * they have to be validated server-side. A failed call keeps every tab: losing
 * the whole workspace because the network blipped is worse than briefly holding
 * a tab whose row is gone.
 */
async function validateCloudWorkspaceTabs(
  orgId: string,
  tabs: WorkspaceTab[],
): Promise<Array<WorkspaceTab | null>> {
  if (tabs.length === 0) return [];
  try {
    const validIds = new Set(
      await validateCloudTabs(
        orgId,
        tabs.map((tab) => ({ id: tab.id, target: tab.target })),
      ),
    );
    return tabs.map((tab) => (validIds.has(tab.id) ? tab : null));
  } catch (e) {
    console.error("[workspace-tabs] cloud validation failed:", e);
    return tabs.map((tab) => tab);
  }
}

/**
 * The dashboard to fall back to — the org's default when signed in, the local
 * default otherwise. Dashboards live on whichever side is active, so this has
 * to branch on the org rather than always reading the local database.
 */
async function resolveDefaultDashboard(
  orgId: string | null,
): Promise<{ id: string; name: string } | null> {
  if (orgId) {
    const list = await listCloudDashboards(orgId);
    const first = list.find((d) => d.isDefault) ?? list[0];
    return first ? { id: first.id, name: first.name } : null;
  }
  const db = await getDb();
  const rows = await db.select<{ id: string; name: string }[]>(
    "SELECT id, name FROM dashboards ORDER BY is_default DESC, name ASC LIMIT 1",
  );
  return rows[0] ?? null;
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

  // Agents, Costs, Cost reports, Invoices, Graph, Logs, Changes, Expiring,
  // Posture, Domains, Env diff, Fan-out, Alerts, Workflows, and Chat tabs
  // aren't backed by a single
  // resource row; keep them as-is.
  if (
    target.kind === "agents" ||
    target.kind === "costs" ||
    target.kind === "cost-reports" ||
    target.kind === "invoices" ||
    target.kind === "graph" ||
    target.kind === "logs" ||
    target.kind === "changes" ||
    target.kind === "expiring" ||
    target.kind === "posture" ||
    target.kind === "dns" ||
    target.kind === "environment-diff" ||
    target.kind === "ssh-fanout" ||
    target.kind === "metric-alerts" ||
    target.kind === "probes" ||
    target.kind === "quotas" ||
    target.kind === "workflows" ||
    target.kind === "deployments" ||
    target.kind === "chat" ||
    target.kind === "settings"
  ) {
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
    // Agent SSH tabs carry a custom "tool · project" title assigned when the
    // tab was created (AgentsPanel.openSession); keep it across restarts.
    // Other resource tabs re-synthesize from the live displayName so renames
    // propagate. Fall back to synthesizing when the stored title is missing
    // or just the generic per-view placeholder.
    const keepStoredTitle =
      !!target.agentSessionId &&
      !!tab.title.trim() &&
      tab.title !== getWorkspaceTabFallbackTitle(target);
    return found
      ? {
          ...tab,
          title: keepStoredTitle ? tab.title : resourceTabTitle(found.displayName, target.view),
          target: {
            ...target,
            resourceId: normalizeResourceId(found.id),
            view: target.view ?? "details",
            pluginId: target.pluginId ?? account.plugin_id,
            resourceTypeId: target.resourceTypeId ?? typeId,
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

  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // On plain routes (Changes, Expiring, Fan-out, Alerts, …) the workspace
  // tabs are all background — the page's own title wins over the active tab.
  useWorkspaceTabDocumentTitle({ suffix: false, routeTitle: plainRouteDocumentTitle(pathname) });
  const hash = useRouterState({ select: (state) => state.location.hash });
  // Under hash history the query string lives inside the hash fragment, so
  // window.location.search is always empty — read it from router state.
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
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
  const [shellCommandInstalled, setShellCommandInstalled] = useState<boolean | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(
    () => useUIStore.getState().activeCloudOrgId,
  );
  const [cloudAuthenticated, setCloudAuthenticated] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    setActiveCloudOrgId(activeOrgId);
  }, [activeOrgId, setActiveCloudOrgId]);

  useEffect(() => {
    startMetricPinger();
    startCronRunner();
    invoke<{ installed: boolean; stale: boolean }>("cli_shell_command_status")
      .then((status) => setShellCommandInstalled(status.installed && !status.stale))
      .catch(() => setShellCommandInstalled(null));
  }, []);

  async function handleInstallShellCommand() {
    try {
      const result = await invoke<{ path: string; note: string | null }>(
        "cli_install_shell_command",
      );
      setShellCommandInstalled(true);
      toast.success(`Installed \`infrawrench\` at ${result.path}`, {
        ...(result.note ? { description: result.note } : {}),
      });
    } catch (e) {
      toast.error("Couldn't install the shell command", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

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
          // Existing sign-ins predate the welcome flow — never show it to them.
          markOnboardingComplete();
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
          if (SHOW_SIGN_IN_BUTTON && !isOnboardingComplete()) setShowOnboarding(true);
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
    const currentTarget = syncWorkspaceRouteFromPath(pathname, hash, searchStr);
    if (!currentTarget) {
      setActiveDashboard(null);
      return;
    }
    setActiveDashboard(currentTarget.kind === "dashboard" ? currentTarget.dashboardId : null);
    // Read tab state via getState and depend only on the location: this effect
    // must react to navigation, never to store-only changes. Depending on
    // workspaceTabs made it fire between navigateToWorkspaceTarget's eager
    // store write and the router committing the new location, re-deriving a
    // target from the STALE pathname and clobbering the tab that was just
    // opened (e.g. the Chat tab reverting to Workflows).
    const { workspaceTabs: tabs, activeWorkspaceTabId: activeId } = useUIStore.getState();
    const activeTab = tabs.find((tab) => tab.id === activeId);
    // Preserves duplicate tab instances that share a target (e.g. multiple Home tabs).
    if (activeTab && workspaceTabTargetsEqual(activeTab.target, currentTarget)) return;
    syncWorkspaceRoute(currentTarget);
  }, [hash, pathname, searchStr, setActiveDashboard, syncWorkspaceRoute, tabsHydrated]);

  useEffect(() => {
    if (!tabsHydrated || tabsValidated) return;
    let cancelled = false;

    // Snapshot at hydration time — workspaceTabs and activeWorkspaceTabId are
    // intentionally excluded from deps so this runs only once.
    const tabsSnapshot = useUIStore.getState().workspaceTabs;
    const activeIdSnapshot = useUIStore.getState().activeWorkspaceTabId;
    // The persisted org rehydrates with the tabs, so it's readable here even
    // though the auth/org effect hasn't resolved yet.
    const orgIdSnapshot = useUIStore.getState().activeCloudOrgId;

    async function validateTabs() {
      const validated = orgIdSnapshot
        ? await validateCloudWorkspaceTabs(orgIdSnapshot, tabsSnapshot)
        : await Promise.all(tabsSnapshot.map((tab) => validateWorkspaceTab(tab)));
      if (cancelled) return;
      // Validation is slow (it can hit plugin APIs), so merge against the LIVE
      // tab list instead of replacing it with the hydration snapshot — the
      // user may have opened, closed, or retitled tabs in the meantime, and a
      // blind replace wipes those out.
      const snapshotById = new Map(tabsSnapshot.map((tab) => [tab.id, tab]));
      const validatedById = new Map(
        tabsSnapshot.map((tab, i) => [tab.id, validated[i] ?? null] as const),
      );
      const current = useUIStore.getState();
      const nextTabs = current.workspaceTabs.flatMap((tab): WorkspaceTab[] => {
        const snap = snapshotById.get(tab.id);
        if (!snap) return [tab]; // opened after the snapshot — keep untouched
        const result = validatedById.get(tab.id);
        if (!result) return []; // backing row is gone — drop
        // Take the validator's refreshed title unless the tab was retitled
        // while validation ran (e.g. a chat auto-rename).
        return [tab.title === snap.title ? { ...tab, title: result.title } : tab];
      });
      const currentActiveId = current.activeWorkspaceTabId;
      const nextActiveId = nextTabs.some((tab) => tab.id === currentActiveId)
        ? currentActiveId
        : ((nextTabs.some((tab) => tab.id === activeIdSnapshot) ? activeIdSnapshot : null) ??
          nextTabs[0]?.id ??
          null);
      replaceWorkspaceTabs(nextTabs, nextActiveId);
      setTabsValidated(true);
      // Validation dropped everything (stale ids, a deleted dashboard), which
      // would leave the window on a route no open tab renders — i.e. blank.
      if (nextTabs.length === 0) {
        const home = await resolveDefaultDashboard(orgIdSnapshot).catch(() => null);
        if (!home || cancelled) return;
        void navigateToWorkspaceTarget(navigate, dashboardTabTarget(home.id), {
          label: home.name,
          replace: true,
        });
      }
    }

    void validateTabs();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, replaceWorkspaceTabs, tabsHydrated, tabsValidated]);

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
    // Both the dashboard and the workflow come from whichever side is active,
    // so a pin never crosses the local/cloud boundary.
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (orgId) {
      await pinCloudWorkflow(orgId, dashboardId, workflow.id);
    } else {
      const db = await getDb();
      await pinWorkflow(workflow.id, dashboardId, db);
    }
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
    const orgId = useUIStore.getState().activeCloudOrgId;
    const home = await resolveDefaultDashboard(orgId).catch(() => null);
    // Only the local side can fall back to a synthesized id; a cloud dashboard
    // id has to come from the org.
    if (!home && orgId) {
      toast.error("Couldn't open a new tab", {
        description: "No dashboards in this organization.",
      });
      return;
    }
    const target = dashboardTabTarget(home?.id ?? "dashboard-home");
    createWorkspaceTabInstance(target, home?.name ?? "Home");
    void navigate(getWorkspaceNavigateArgs(target));
  }

  async function handleSwitchOrg(orgId: string | null) {
    setActiveOrgId(orgId);
    try {
      const first = await resolveDefaultDashboard(orgId);
      if (!first) return;
      void navigateToWorkspaceTarget(navigate, dashboardTabTarget(first.id), {
        label: first.name,
      });
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

        <ProviderIncidentShellBanner />

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
                {/* Org settings are cloud-backed; local-only mode has no org
                    to configure, so no tile without one. Same shared sections
                    the web renders — see DesktopSettingsPanel. */}
                {activeOrgId && (
                  <button
                    type="button"
                    onClick={() =>
                      void navigateToWorkspaceTarget(navigate, settingsTabTarget(), {
                        label: "Settings",
                      })
                    }
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
                  >
                    <span className="text-base leading-none">&#9881;</span>
                    Settings
                  </button>
                )}
                {shellCommandInstalled === false && (
                  <button
                    type="button"
                    onClick={() => {
                      void handleInstallShellCommand();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
                    title="Adds an `infrawrench` command to your PATH so you can use the CLI and TUI from any terminal."
                  >
                    <span className="text-base leading-none font-mono">&gt;_</span>
                    Install shell command
                  </button>
                )}
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
                (index); tab routes' components are no-ops. */}
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

      {showOnboarding && (
        <Onboarding
          onSignedIn={(orgs) => {
            setCloudAuthenticated(true);
            setCloudOrgs(orgs);
          }}
          onSelectOrg={(orgId) => {
            void handleSwitchOrg(orgId);
          }}
          onDone={() => {
            markOnboardingComplete();
            setShowOnboarding(false);
          }}
        />
      )}

      <SwipeIndicator gesture={swipeGesture} />
      <SshHostKeyPromptHost />
      <PromptHost />
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
