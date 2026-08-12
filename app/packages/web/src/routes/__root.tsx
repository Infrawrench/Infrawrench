import { useState, useEffect } from "react";
import { useGT } from "gt-react";
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  DndShell,
  GlobalTabBar,
  PublicStatusPageView,
  TunnelSshAttachModal,
  useUIStore,
  useWorkspaceTabDocumentTitle,
  useWorkspaceTabHandlers,
  workspaceTabTargetsEqual,
  dispatchResourcesChanged,
  type DraggableResource,
  type DraggableWorkflow,
  type TunnelSshAttachResult,
  type TunnelSshAttachZone,
  type TunnelSshAttachKey,
} from "@infrawrench/ui";
import { PromptHost } from "@infrawrench/ui/workflows";
import { WebSidebar } from "@/components/WebSidebar";
import { ChangeFreezeBanner } from "@/components/ChangeFreezeBanner";
import { ProviderIncidentShellBanner } from "@/components/ProviderIncidentShellBanner";
import { SpotlightSearch } from "@/components/SpotlightSearch";
import { WebWorkspaceTabsViewport } from "@/components/WorkspaceTabsViewport";
import { OrgProviders } from "@/components/OrgProviders";
import { apiGet, apiPost } from "@/lib/api";
import {
  dashboardTabTarget,
  getWorkspaceNavigateArgs,
  plainRouteDocumentTitle,
  syncWorkspaceRouteFromPath,
} from "@/lib/workspace-tabs";
import { useGithubInstallResultToast } from "@/lib/github-install-result";

export const Route = createRootRoute({
  component: RootLayout,
});

interface AuthMe {
  userId: string;
  email: string;
  needsOnboarding: boolean;
}

interface TunnelAttachState {
  tunnel: DraggableResource;
  host: DraggableResource;
  zones: TunnelSshAttachZone[];
  sshKeys: TunnelSshAttachKey[];
  defaultUsername: string;
}

/**
 * Routes that render with no account at all.
 *
 * Distinct from `/invite/` and `/admin`, which skip the *onboarding redirect*
 * but still call `/api/auth/me`: a public status page must not make that call.
 * Hitting an authenticated endpoint would redirect an anonymous visitor to
 * sign-in, which is precisely what a public status page cannot do — the page
 * exists for people who have no relationship with the org beyond the link.
 *
 * Custom domains (served by status-page-edge) load the same SPA shell at `/`
 * on a non-app hostname; those hosts are also public and must skip auth.
 */
const APP_HOSTS = new Set(["localhost", "127.0.0.1", "app.infrawrench.com"]);

function isCustomStatusHost(): boolean {
  if (typeof window === "undefined") return false;
  return !APP_HOSTS.has(window.location.hostname);
}

function isPublicRoute(pathname: string): boolean {
  return pathname.startsWith("/status/") || isCustomStatusHost();
}

function PublicStatusPageOnCustomHost() {
  const [page, setPage] = useState<import("@infrawrench/client-core").PublicStatusPage | null>(
    null,
  );
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/status", {
          headers: { Accept: "application/json" },
          credentials: "omit",
        });
        if (cancelled) return;
        if (res.status === 404) {
          setState("missing");
          return;
        }
        if (!res.ok) {
          setState("error");
          return;
        }
        setPage((await res.json()) as import("@infrawrench/client-core").PublicStatusPage);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (page) document.title = page.title;
  }, [page]);

  if (state === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface-tertiary">
        <div className="animate-pulse text-sm">Loading…</div>
      </div>
    );
  }

  if (state === "missing" || state === "error") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface px-4 text-center">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">
            {state === "missing" ? "Status page not found" : "Status page unavailable"}
          </h1>
          <p className="mt-2 text-sm text-on-surface-secondary">
            {state === "missing"
              ? "This domain is not linked to a published status page."
              : "Something went wrong loading this page. Try again in a moment."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface">{page && <PublicStatusPageView page={page} />}</div>
  );
}

/**
 * Routes that need a signed-in visitor but must be left exactly where they are.
 *
 * Everything not listed here is funnelled to the visitor's first organization
 * (or to onboarding), which is right for a bare `/` and wrong for any page that
 * *is* the destination. Three ways that funnel breaks such a page, all of which
 * `/claim` hit at once: a visitor with an org is redirected away and the
 * `?code=` in the URL goes with them, a visitor with none waits on a spinner
 * that never resolves because `setAuthChecked` is only reached through the
 * `/org/` branch, and an anonymous visitor is bounced to sign-in and lands back
 * in one of the first two.
 *
 * `/claim` in particular must also survive having **no organization at all** —
 * claiming is how its visitor gets their first one, so sending them to
 * onboarding first would be asking them to build the workspace they were
 * invited to take over.
 */
function skipsOrgRedirect(pathname: string): boolean {
  return (
    pathname.startsWith("/onboarding") ||
    pathname.startsWith("/invite/") ||
    pathname.startsWith("/share/") ||
    pathname.startsWith("/admin") ||
    pathname === "/claim"
  );
}

function RootLayout() {
  const gt = useGT();
  const [authChecked, setAuthChecked] = useState(false);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Must run before the auth redirect below replaces the URL (and its params).
  useGithubInstallResultToast();

  useEffect(() => {
    if (isPublicRoute(pathname)) return;
    if (skipsOrgRedirect(pathname)) {
      // These routes still need an auth check, but we don't redirect them to onboarding.
      apiGet<AuthMe>("/api/auth/me")
        .then(() => setAuthChecked(true))
        .catch(() => {
          /* apiFetch redirects on 401 */
        });
      return;
    }

    apiGet<AuthMe>("/api/auth/me")
      .then(async (me) => {
        if (me.needsOnboarding) {
          void navigate({ to: "/onboarding" });
          return;
        }

        if (!pathname.startsWith("/org/")) {
          const orgs = await apiGet<Array<{ id: string }>>("/api/auth/orgs");
          if (orgs.length > 0) {
            void navigate({ to: "/org/$orgId", params: { orgId: orgs[0]!.id }, replace: true });
          }
          return;
        }

        setAuthChecked(true);
      })
      .catch(() => {
        /* apiFetch redirects on 401 */
      });
  }, [navigate, pathname]);

  // Vanity hosts never run the authenticated shell.
  if (isCustomStatusHost()) return <PublicStatusPageOnCustomHost />;

  // Rendered before any auth state is consulted — see isPublicRoute.
  if (isPublicRoute(pathname)) return <Outlet />;

  if (!authChecked) {
    if (skipsOrgRedirect(pathname)) {
      return <Outlet />;
    }

    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface-tertiary">
        <div className="animate-pulse text-sm">{gt("Loading…")}</div>
      </div>
    );
  }

  if (skipsOrgRedirect(pathname)) {
    return <Outlet />;
  }

  // Redirect to /org/:orgId is in-flight; render the loading state rather
  // than the shell with orgId=null (would show "Select organization").
  if (!pathname.startsWith("/org/")) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface-tertiary">
        <div className="animate-pulse text-sm">{gt("Loading…")}</div>
      </div>
    );
  }

  return <AuthenticatedShell />;
}

function AuthenticatedShell() {
  const gt = useGT();
  const [tunnelAttach, setTunnelAttach] = useState<TunnelAttachState | null>(null);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash = useRouterState({ select: (s) => s.location.hash });
  // The search string must come from the SAME router state snapshot as the
  // pathname and hash. @tanstack/history flushes the real history.pushState
  // asynchronously, so window.location.search — which syncWorkspaceRouteFromPath
  // falls back to — can still be the previous route's query while the router
  // already reports the new hash. For a freshly launched Linux app that mixed
  // state read as "#window with no window", parsed as the resource detail, and
  // replaced the app tab the user just opened with the VM's info page.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  // Keyed by org rather than a boolean: switching orgs must re-validate,
  // since the persisted tabs are global and the previous org's tabs point at
  // ids that don't exist in the new one.
  const [tabsValidatedForOrg, setTabsValidatedForOrg] = useState<string | null>(null);

  const orgIdMatch = pathname.match(/^\/org\/([^/]+)/);
  const orgId = orgIdMatch?.[1] ? decodeURIComponent(orgIdMatch[1]) : null;
  const tabsValidated = tabsValidatedForOrg === orgId;

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

  const { handleActivateTab, handleCloseTab } = useWorkspaceTabHandlers(
    navigate,
    getWorkspaceNavigateArgs,
  );

  // On plain routes (Moment, Admin) the workspace tabs are all background —
  // the page's own title wins over the active tab.
  useWorkspaceTabDocumentTitle({ routeTitle: plainRouteDocumentTitle(pathname) });

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
    // opened (e.g. a freshly launched Linux app tab reverting to the
    // launcher). Same fix as the desktop's __root.
    const { workspaceTabs: tabs, activeWorkspaceTabId: activeId } = useUIStore.getState();
    const activeTab = tabs.find((tab) => tab.id === activeId);
    if (activeTab && workspaceTabTargetsEqual(activeTab.target, currentTarget)) return;
    syncWorkspaceRoute(currentTarget);
  }, [hash, pathname, searchStr, setActiveDashboard, syncWorkspaceRoute, tabsHydrated]);

  useEffect(() => {
    if (!tabsHydrated || tabsValidated) return;
    const tabsSnapshot = useUIStore.getState().workspaceTabs;
    const activeIdSnapshot = useUIStore.getState().activeWorkspaceTabId;
    if (tabsSnapshot.length === 0) {
      setTabsValidatedForOrg(orgId);
      return;
    }
    if (!orgId) {
      setTabsValidatedForOrg(null);
      return;
    }

    let cancelled = false;
    apiPost<{ validTabIds: string[] }>(`/api/org/${orgId}/dashboards/validate-tabs`, {
      tabs: tabsSnapshot.map((t) => ({ id: t.id, target: t.target })),
    })
      .then(({ validTabIds }) => {
        if (cancelled) return;
        const validSet = new Set(validTabIds);
        const nextTabs = tabsSnapshot.filter((t) => validSet.has(t.id));
        replaceWorkspaceTabs(nextTabs, activeIdSnapshot);
        setTabsValidatedForOrg(orgId);
      })
      .catch(() => {
        if (!cancelled) setTabsValidatedForOrg(orgId);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsHydrated, tabsValidated, replaceWorkspaceTabs, orgId]);

  async function handleNewTab() {
    if (!orgId) return;
    try {
      const data = await apiGet<{ dashboard: { id: string; name: string } }>(
        `/api/org/${orgId}/dashboards/default/full`,
      );
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

  async function handlePinWorkflowToDashboard(workflow: DraggableWorkflow, dashboardId: string) {
    if (!orgId) return;
    await apiPost(`/api/org/${orgId}/dashboards/workflow-pin`, {
      dashboardId,
      workflowId: workflow.id,
    });
    useUIStore.getState().bumpDashboardPins();
    dispatchResourcesChanged();
  }

  async function handleResourceAttach(source: DraggableResource, target: DraggableResource) {
    if (!orgId) return;
    try {
      await apiPost(`/api/org/${orgId}/resources/attach`, {
        pluginId: source.pluginId,
        accountId: source.accountId,
        sourceTypeId: source.resourceTypeId,
        sourceResourceId: source.externalId ?? source.id,
        targetTypeId: target.resourceTypeId,
        targetResourceId: target.externalId ?? target.id,
      });
      dispatchResourcesChanged();
    } catch (e) {
      window.alert(
        gt("Attach failed: {error}", { error: e instanceof Error ? e.message : String(e) }),
      );
    }
  }

  async function handleTunnelSshAttach(tunnel: DraggableResource, host: DraggableResource) {
    if (!orgId) return;
    try {
      const [config, keysResp] = await Promise.all([
        apiPost<{ fields?: Array<{ key: string; options?: { id: string; label: string }[] }> }>(
          `/api/org/${orgId}/resources/create-config`,
          { accountId: tunnel.accountId, resourceTypeId: "dns-record", pluginId: "cloudflare" },
        ),
        apiGet<Array<{ id: string; name: string }>>(`/api/org/${orgId}/ssh-keys`),
      ]);
      const zones: TunnelSshAttachZone[] = (
        config.fields?.find((f) => f.key === "zoneId")?.options ?? []
      ).map((o) => ({ id: o.id, label: o.label }));
      const sshKeys: TunnelSshAttachKey[] = (keysResp ?? []).map((k) => ({
        id: k.id,
        label: k.name,
      }));
      setTunnelAttach({
        tunnel,
        host,
        zones,
        sshKeys,
        defaultUsername: String(host.fields["sshUsername"] ?? "root"),
      });
    } catch (e) {
      window.alert(
        gt("Couldn't start SSH tunnel setup: {error}", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  return (
    // Org-scoped contexts wrap the *whole* shell: the workspace-tab viewport
    // below is a sibling of the <Outlet/>, so anything provided by the
    // /org/$orgId layout route would miss every tab. See OrgProviders.
    <OrgProviders orgId={orgId}>
      <DndShell
        onPinToDashboard={handlePinToDashboard}
        onPinWorkflowToDashboard={handlePinWorkflowToDashboard}
        onResourceAttach={handleResourceAttach}
        onTunnelSshAttach={(t, h) => void handleTunnelSshAttach(t, h)}
      >
        <div className="flex flex-col h-screen bg-surface text-on-surface">
          {/* First tab stop on every page: without it a keyboard user walks the
            whole tab strip and sidebar again after each navigation. Mirrors
            desktop's `__root.tsx`. */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-1.5 focus:rounded focus:bg-surface-overlay focus:text-on-surface focus:border focus:border-border-strong focus:shadow-lg"
          >
            {gt("Skip to content")}
          </a>
          <GlobalTabBar
            tabs={workspaceTabs}
            activeTabId={activeWorkspaceTabId}
            onActivate={handleActivateTab}
            onClose={handleCloseTab}
            onNew={handleNewTab}
          />
          {orgId && <ChangeFreezeBanner orgId={orgId} />}
          {orgId && <ProviderIncidentShellBanner orgId={orgId} />}
          <div className="flex flex-1 overflow-hidden">
            <WebSidebar orgId={orgId} />
            <main id="main-content" className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {/* Tabs are rendered via WorkspaceTabsViewport: every open tab
                stays mounted so SSH sessions / xterm scrollback / websocket
                subscriptions survive tab switches. <Outlet/> still renders
                non-tab routes like /onboarding, plus /settings (a tab in the
                strip whose content is route-rendered); other tab routes'
                components are no-ops. */}
              {orgId && <WebWorkspaceTabsViewport orgId={orgId} tabsValidated={tabsValidated} />}
              <Outlet />
            </main>
          </div>
        </div>
        {/* Renders input requests raised by a running workflow or Infrafile. */}
        <PromptHost />
        {spotlightOpen && (
          <SpotlightSearch mode="navigate" onClose={() => setSpotlightOpen(false)} />
        )}
        {tunnelAttach && orgId && (
          <TunnelSshAttachModal
            tunnelName={tunnelAttach.tunnel.displayName}
            hostName={tunnelAttach.host.displayName}
            zones={tunnelAttach.zones}
            sshKeys={tunnelAttach.sshKeys}
            showSshKeyPicker
            defaultUsername={tunnelAttach.defaultUsername}
            onClose={() => setTunnelAttach(null)}
            onRun={(params) =>
              apiPost<TunnelSshAttachResult>(`/api/org/${orgId}/resources/tunnel-ssh-attach`, {
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
              })
            }
          />
        )}
      </DndShell>
    </OrgProviders>
  );
}
