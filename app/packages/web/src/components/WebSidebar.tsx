import { useState, useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  useUIStore,
  DroppableDashboardItem,
  DraggableSidebarResource,
  RESOURCES_CHANGED_EVENT,
  dispatchResourcesChanged,
  OrgSwitcher,
  ManageAccountsModal,
  SidebarApps,
  SidebarHomeButton,
  SidebarRecentTools,
  useShowsInfrastructureSidebar,
  toast,
  useDataString,
  type Account,
  type Dashboard,
  type OrgEntry,
  ChevronIcon,
  CloseIcon,
  PanelLeftCloseIcon,
  IssueIndicator,
  ProviderOAuthReconnectBadge,
  isProviderOAuthCancelled,
  formatErrorMessage,
  PanelLeftOpenIcon,
  SettingsIcon,
  usePaletteIntent,
} from "@infrawrench/ui";
import { CHAT_CONVERSATIONS_CHANGED_EVENT, type ConversationSummary } from "@infrawrench/ui";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import {
  accountTabTarget,
  chatTabTarget,
  homeTabTarget,
  complianceTabTarget,
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
} from "@/lib/workspace-tabs";
import { accountSyncsResources } from "@infrawrench/client-core";
import { useAppSettingsShortcut } from "@/lib/app-settings";
import { useOrgTools } from "@/lib/org-tools";
import { AddAccountModal } from "./AddAccountModal";
import { reconnectProviderAccount } from "@/lib/provider-oauth";

interface ResourceSummary {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId?: string | null;
  fieldsJson?: Record<string, unknown> | null;
}

interface ResourceTypeMeta {
  id: string;
  attachTargets?: Array<{
    pluginId: string;
    resourceTypeId: string;
    matchField?: string;
    verb?: string;
  }>;
  isSshHost?: boolean;
  sshTunnelAttachSource?: boolean;
}

interface PluginGroup {
  pluginId: string;
  displayName: string;
  logoSvg: string;
  /** The server can run this plugin's OAuth flow, so Reconnect can show. */
  oauthAvailable: boolean;
  accounts: Account[];
}

interface WebSidebarProps {
  orgId: string | null;
}

const EMPTY_EXPANDED: ReadonlySet<string> = new Set();
const EMPTY_RESOURCES: Record<
  string,
  {
    loading: boolean;
    resources: ResourceSummary[];
    error?: string | undefined;
    warning?: string | undefined;
  }
> = {};

export function WebSidebar({ orgId }: WebSidebarProps) {
  const gt = useGT();
  const gtData = useDataString();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [groups, setGroups] = useState<PluginGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedStore, setExpandedStore] = useState<{ forOrg: string | null; set: Set<string> }>({
    forOrg: orgId,
    set: new Set(),
  });
  const [accountResourcesStore, setAccountResourcesStore] = useState<{
    forOrg: string | null;
    map: Record<
      string,
      {
        loading: boolean;
        resources: ResourceSummary[];
        error?: string | undefined;
        warning?: string | undefined;
      }
    >;
  }>({ forOrg: orgId, map: {} });

  const expanded = expandedStore.forOrg === orgId ? expandedStore.set : EMPTY_EXPANDED;
  const accountResources =
    accountResourcesStore.forOrg === orgId ? accountResourcesStore.map : EMPTY_RESOURCES;
  const [accountTypeMeta, setAccountTypeMeta] = useState<
    Record<string, Record<string, ResourceTypeMeta>>
  >({});
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showManageAccounts, setShowManageAccounts] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);

  // Dashboard state
  const [dashboardList, setDashboardList] = useState<Dashboard[]>([]);
  const [addingDashboard, setAddingDashboard] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const newDashboardRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // Chat session state
  const [chatSessions, setChatSessions] = useState<ConversationSummary[]>([]);

  // Org switcher state
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  // The command palette's "Create dashboard" and "Connect account" land on
  // the flows this sidebar owns (it expands the sidebar first).
  usePaletteIntent(
    (intent) =>
      intent.type === "create" && (intent.kind === "dashboard" || intent.kind === "account"),
    (intent) => {
      if (intent.kind === "dashboard") setAddingDashboard(true);
      else setShowAddAccount(true);
    },
  );
  const accountsVersion = useUIStore((s) => s.accountsVersion);
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);

  // Refetch when orgId changes so a newly-created org appears.
  useEffect(() => {
    apiGet<OrgEntry[]>("/api/auth/orgs")
      .then((data) => {
        setOrgs(data);
        setOrgsLoaded(true);
      })
      .catch(console.error);
  }, [orgId]);

  // API base path for org-scoped calls
  const apiBase = orgId ? `/api/org/${orgId}` : null;

  useEffect(() => {
    if (!apiBase) return;
    apiGet<Dashboard[]>(`${apiBase}/dashboards`).then(setDashboardList).catch(console.error);
  }, [apiBase, dashboardPinsVersion]);

  const orgTools = useOrgTools(orgId ?? undefined);
  const settingsFor = useAppSettingsShortcut();
  const showAccounts = useShowsInfrastructureSidebar();

  // Chat sessions: load on org change and refresh when conversations change
  // (new chat, archive, rename after the first turn).
  useEffect(() => {
    if (!apiBase) return;
    function loadChats() {
      apiGet<{ conversations: ConversationSummary[] }>(`${apiBase}/chat/conversations`)
        .then((res) => setChatSessions(res.conversations))
        .catch(console.error);
    }
    loadChats();
    window.addEventListener(CHAT_CONVERSATIONS_CHANGED_EVENT, loadChats);
    return () => window.removeEventListener(CHAT_CONVERSATIONS_CHANGED_EVENT, loadChats);
  }, [apiBase]);

  async function handleNewChat() {
    if (!apiBase) return;
    try {
      const created = await apiPost<{ id: string }>(`${apiBase}/chat/conversations`, {});
      window.dispatchEvent(new Event(CHAT_CONVERSATIONS_CHANGED_EVENT));
      void navigateToWorkspaceTarget(navigate, chatTabTarget(created.id), {
        label: gt("New chat"),
      });
    } catch (e) {
      console.error("Failed to create chat:", e);
      toast.error(gt("Couldn't create chat"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function handleArchiveChat(id: string) {
    if (!apiBase) return;
    try {
      await apiDelete(`${apiBase}/chat/conversations/${id}`);
      setChatSessions((prev) => prev.filter((c) => c.id !== id));
      window.dispatchEvent(new Event(CHAT_CONVERSATIONS_CHANGED_EVENT));
      // Leave the archived conversation before dropping its tab: the root
      // route effect re-adds a tab for whatever the URL still points at.
      if (pathname === `/org/${orgId}/chat/${id}`) {
        await navigate({ to: "/org/$orgId/chat", params: { orgId: orgId! } });
      }
      const { workspaceTabs, removeWorkspaceTabs } = useUIStore.getState();
      removeWorkspaceTabs(
        workspaceTabs.flatMap((tab) =>
          tab.target.kind === "chat" && tab.target.conversationId === id ? [tab.id] : [],
        ),
      );
    } catch (e) {
      console.error("Failed to archive chat:", e);
      toast.error(gt("Couldn't archive chat"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  useEffect(() => {
    if (!apiBase) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [accts, pluginList] = await Promise.all([
          apiGet<Account[]>(`${apiBase}/accounts`),
          apiGet<Array<{ id: string; displayName: string; logoSvg: string; oauth?: unknown }>>(
            `${apiBase}/accounts/plugins`,
          ),
        ]);
        if (cancelled) return;

        const pluginMeta = Object.fromEntries(
          pluginList.map((p) => [
            p.id,
            { displayName: p.displayName, logoSvg: p.logoSvg, oauthAvailable: !!p.oauth },
          ]),
        );

        const groupMap = new Map<string, PluginGroup>();
        for (const acct of accts) {
          if (!groupMap.has(acct.pluginId)) {
            groupMap.set(acct.pluginId, {
              pluginId: acct.pluginId,
              displayName: pluginMeta[acct.pluginId]?.displayName ?? acct.pluginId,
              logoSvg: pluginMeta[acct.pluginId]?.logoSvg ?? "",
              oauthAvailable: pluginMeta[acct.pluginId]?.oauthAvailable ?? false,
              accounts: [],
            });
          }
          groupMap.get(acct.pluginId)!.accounts.push(acct);
        }
        setGroups([...groupMap.values()]);
      } catch (e) {
        console.error("Sidebar load error:", e);
        toast.error(gt("Couldn't load sidebar"), {
          description: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [apiBase, accountsVersion]);

  useEffect(() => {
    if (addingDashboard) newDashboardRef.current?.focus();
  }, [addingDashboard]);

  useEffect(() => {
    if (renamingId) renameRef.current?.focus();
  }, [renamingId]);

  function handleOrgSwitch(newOrgId: string | null) {
    if (newOrgId && newOrgId !== orgId) {
      void navigate({ to: "/org/$orgId", params: { orgId: newOrgId } });
    }
  }

  async function handleCreateDashboard() {
    if (!apiBase) return;
    const name = newDashboardName.trim();
    setAddingDashboard(false);
    setNewDashboardName("");
    if (!name) return;
    try {
      const created = await apiPost<{ id: string; name: string }>(`${apiBase}/dashboards`, {
        name,
      });
      if (created) {
        setDashboardList((prev) => [
          ...prev,
          { id: created.id, name: created.name, isDefault: false },
        ]);
        void navigate({
          to: "/org/$orgId/dashboard/$dashboardId",
          params: { orgId: orgId!, dashboardId: created.id },
        });
      }
    } catch (e) {
      console.error("Failed to create dashboard:", e);
      toast.error(gt("Couldn't create dashboard"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function handleRename() {
    if (!apiBase) return;
    const name = renameValue.trim();
    const id = renamingId;
    setRenamingId(null);
    setRenameValue("");
    if (!name || !id) return;
    try {
      await apiPost(`${apiBase}/dashboards/${id}/rename`, { name });
      setDashboardList((prev) => prev.map((d) => (d.id === id ? { ...d, name } : d)));
    } catch (e) {
      console.error("Failed to rename dashboard:", e);
      toast.error(gt("Couldn't rename dashboard"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function handleDelete(id: string) {
    if (!apiBase) return;
    try {
      await apiDelete(`${apiBase}/dashboards/${id}`);
      setDashboardList((prev) => prev.filter((d) => d.id !== id));
      if (pathname === `/org/${orgId}/dashboard/${id}`) {
        void navigate({ to: "/org/$orgId", params: { orgId: orgId! } });
      }
    } catch (e) {
      console.error("Failed to delete dashboard:", e);
      toast.error(gt("Couldn't delete dashboard"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function loadResources(accountId: string, background = false) {
    if (!apiBase) return;
    if (!background) {
      setAccountResourcesStore((prev) => {
        const base = prev.forOrg === orgId ? prev.map : {};
        return {
          forOrg: orgId,
          map: {
            ...base,
            [accountId]: { loading: true, resources: base[accountId]?.resources ?? [] },
          },
        };
      });
    }

    try {
      const detailPromise = background
        ? Promise.resolve(null)
        : apiGet<{ resourceTypes: ResourceTypeMeta[] }>(
            `${apiBase}/accounts/${accountId}/detail`,
          ).catch(() => null);
      const [existing, detail] = await Promise.all([
        apiGet<ResourceSummary[]>(`${apiBase}/accounts/${accountId}/resources?topLevelOnly=true`),
        detailPromise,
      ]);
      if (detail) {
        const lookup = Object.fromEntries(detail.resourceTypes.map((t) => [t.id, t]));
        setAccountTypeMeta((prev) => ({ ...prev, [accountId]: lookup }));
      }
      setAccountResourcesStore((prev) => {
        const base = prev.forOrg === orgId ? prev.map : {};
        return {
          forOrg: orgId,
          map: { ...base, [accountId]: { loading: false, resources: existing } },
        };
      });
      // A connection made for Costs only keeps no inventory: the server
      // refuses its resource sync, so there is nothing to refresh.
      const account = groups.flatMap((g) => g.accounts).find((a) => a.id === accountId);
      if (!accountSyncsResources(account?.products)) return;
      apiPost<{ incompleteLists?: Array<{ message: string }> }>(
        `${apiBase}/accounts/${accountId}/sync`,
      )
        .then(async ({ incompleteLists }) => ({
          fresh: await apiGet<ResourceSummary[]>(
            `${apiBase}/accounts/${accountId}/resources?topLevelOnly=true`,
          ),
          incomplete: incompleteLists?.[0]?.message,
        }))
        .then(({ fresh, incomplete }) => {
          setAccountResourcesStore((prev) => {
            const base = prev.forOrg === orgId ? prev.map : {};
            return {
              forOrg: orgId,
              map: {
                ...base,
                [accountId]: {
                  loading: false,
                  resources: fresh,
                  ...(incomplete
                    ? { warning: gt("Couldn't refresh resources: {error}", { error: incomplete }) }
                    : {}),
                },
              },
            };
          });
        })
        .catch((e) => {
          console.error("Background sync failed:", e);
          const message = e instanceof Error ? e.message : String(e);
          setAccountResourcesStore((prev) => {
            const base = prev.forOrg === orgId ? prev.map : {};
            const current = base[accountId];
            return {
              forOrg: orgId,
              map: {
                ...base,
                [accountId]: {
                  loading: false,
                  resources: current?.resources ?? existing,
                  warning: gt("Couldn't refresh resources: {error}", { error: message }),
                },
              },
            };
          });
        });
    } catch (e) {
      if (background) return;
      setAccountResourcesStore((prev) => {
        const base = prev.forOrg === orgId ? prev.map : {};
        return {
          forOrg: orgId,
          map: {
            ...base,
            [accountId]: {
              loading: false,
              resources: [],
              error: e instanceof Error ? e.message : gt("Failed to load resources"),
            },
          },
        };
      });
    }
  }

  function reconnectAccount(account: Account, providerName: string) {
    if (!orgId) return;
    setReconnectingId(account.id);
    reconnectProviderAccount(orgId, account.id, account.pluginId)
      .then(() => {
        toast.success(gt("Reconnected {provider}", { provider: gtData(providerName) }));
        useUIStore.getState().bumpAccounts();
        dispatchResourcesChanged({ accountId: account.id });
      })
      .catch((e: unknown) => {
        if (isProviderOAuthCancelled(e)) return;
        toast.error(gt("Couldn't reconnect: {message}", { message: formatErrorMessage(e) }));
      })
      .finally(() => setReconnectingId((cur) => (cur === account.id ? null : cur)));
  }

  async function toggleExpand(accountId: string) {
    const isNowExpanded = !expanded.has(accountId);
    setExpandedStore((prev) => {
      const next = new Set(prev.forOrg === orgId ? prev.set : []);
      if (isNowExpanded) next.add(accountId);
      else next.delete(accountId);
      return { forOrg: orgId, set: next };
    });
    if (!isNowExpanded) return;
    if (accountResources[accountId]) return;
    void loadResources(accountId);
  }

  // Reload expanded accounts when resources change
  useEffect(() => {
    function handler() {
      for (const accountId of expanded) {
        void loadResources(accountId, true);
      }
    }
    window.addEventListener(RESOURCES_CHANGED_EVENT, handler);
    return () => window.removeEventListener(RESOURCES_CHANGED_EVENT, handler);
  }, [expanded, apiBase]);

  // Auto-refresh expanded accounts every 30s
  useEffect(() => {
    if (expanded.size === 0) return;
    const id = setInterval(() => {
      for (const accountId of expanded) {
        void loadResources(accountId, true);
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [expanded, apiBase]);

  if (sidebarCollapsed) {
    return (
      <button
        type="button"
        onClick={toggleSidebar}
        className="surface-sidebar w-8 border-r border-border flex items-center justify-center text-on-surface-faint hover:text-on-surface-tertiary transition-colors flex-shrink-0"
        aria-label={gt("Expand sidebar")}
      >
        <PanelLeftOpenIcon />
      </button>
    );
  }

  return (
    <>
      <aside className="surface-sidebar w-60 border-r border-border flex flex-col overflow-hidden flex-shrink-0">
        <div className="flex items-center justify-between p-1 border-b border-border">
          <div className="flex-1 min-w-0">
            <OrgSwitcher
              orgs={orgs}
              activeOrgId={orgId}
              onSwitch={handleOrgSwitch}
              onCreateOrg={() => void navigate({ to: "/onboarding" })}
              loading={!orgsLoaded}
            />
          </div>
          <button
            type="button"
            onClick={toggleSidebar}
            className="text-on-surface-faint hover:text-on-surface-tertiary transition-colors text-xs px-2"
            aria-label={gt("Collapse sidebar")}
          >
            <PanelLeftCloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <SidebarHomeButton
            active={pathname.startsWith(`/org/${orgId}/home`)}
            onClick={() => void navigateToWorkspaceTarget(navigate, homeTabTarget())}
          />
          {/* Dashboards section */}
          <div className="mb-2">
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wide">
                {gt("Dashboards")}
              </span>
              <button
                type="button"
                onClick={() => setAddingDashboard(true)}
                title={gt("New dashboard")}
                className="text-on-surface-faint hover:text-on-surface-secondary text-sm leading-none size-5 flex items-center justify-center rounded hover:bg-surface-overlay transition-colors"
              >
                +
              </button>
            </div>

            {dashboardList.map((dash) => {
              // Every dashboard has its own address, the caller's default
              // included: the org's landing page is Home, not a dashboard.
              const dashHref = `/org/${orgId}/dashboard/${dash.id}`;
              const isActive = pathname === dashHref;

              if (renamingId === dash.id) {
                return (
                  <div key={dash.id} className="mx-2 px-3 py-1">
                    <input
                      ref={renameRef}
                      aria-label={gt("Dashboard name")}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void handleRename()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleRename();
                        if (e.key === "Escape") {
                          setRenamingId(null);
                          setRenameValue("");
                        }
                      }}
                      className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-accent-subtle"
                    />
                  </div>
                );
              }

              return (
                <DroppableDashboardItem
                  key={dash.id}
                  dashboardId={dash.id}
                  name={dash.name}
                  isActive={isActive}
                  isDefault={dash.isDefault}
                  onClick={() => void navigate({ to: dashHref })}
                  onDoubleClick={
                    !dash.isDefault
                      ? () => {
                          setRenamingId(dash.id);
                          setRenameValue(dash.name);
                        }
                      : undefined
                  }
                  onDelete={!dash.isDefault ? () => void handleDelete(dash.id) : undefined}
                />
              );
            })}

            {/* New dashboard inline input */}
            {addingDashboard && (
              <div className="mx-2 px-3 py-1.5">
                <input
                  ref={newDashboardRef}
                  aria-label={gt("New dashboard name")}
                  value={newDashboardName}
                  onChange={(e) => setNewDashboardName(e.target.value)}
                  placeholder={gt("Dashboard name...")}
                  onBlur={() => void handleCreateDashboard()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateDashboard();
                    if (e.key === "Escape") {
                      setAddingDashboard(false);
                      setNewDashboardName("");
                    }
                  }}
                  className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-accent-subtle"
                />
              </div>
            )}
          </div>

          {/* Chat sessions section */}
          <div className="mb-2">
            <div className="flex items-center justify-between px-3 py-1">
              <button
                type="button"
                onClick={() =>
                  void navigateToWorkspaceTarget(navigate, chatTabTarget(), { label: gt("Chat") })
                }
                className="text-xs font-medium text-on-surface-muted uppercase tracking-wide hover:text-on-surface-secondary transition-colors"
              >
                {gt("Chat")}
              </button>
              <button
                type="button"
                onClick={() => void handleNewChat()}
                title={gt("New chat")}
                className="text-on-surface-faint hover:text-on-surface-secondary text-sm leading-none size-5 flex items-center justify-center rounded hover:bg-surface-overlay transition-colors"
              >
                +
              </button>
            </div>

            {chatSessions.slice(0, 8).map((chat) => {
              const isActive = pathname === `/org/${orgId}/chat/${chat.id}`;
              return (
                <div
                  key={chat.id}
                  className={`group mx-2 flex items-center rounded-lg transition-colors ${
                    isActive
                      ? "bg-surface-overlay text-on-surface"
                      : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      void navigateToWorkspaceTarget(navigate, chatTabTarget(chat.id), {
                        label: chat.title,
                      })
                    }
                    className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs"
                  >
                    <span className="block truncate">{chat.title}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleArchiveChat(chat.id)}
                    title={gt("Archive chat")}
                    aria-label={gt("Archive chat")}
                    className="opacity-0 group-hover:opacity-100 text-on-surface-faint hover:text-danger text-xs px-2 py-1.5 transition-opacity"
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              );
            })}

            {chatSessions.length > 8 && (
              <button
                type="button"
                onClick={() =>
                  void navigateToWorkspaceTarget(navigate, chatTabTarget(), { label: gt("Chat") })
                }
                className="mx-2 px-3 py-1 text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
              >
                {gt("All chats…")}
              </button>
            )}
          </div>

          {/* Plugin groups: Infrastructure's part of the sidebar, shown only
              in its context (see showsInfrastructureSidebar). Hidden rather
              than unmounted so expanded accounts survive a visit elsewhere. */}
          <div hidden={!showAccounts}>
            {loading && (
              <div className="px-3 py-2 text-xs text-on-surface-faint">{gt("Loading…")}</div>
            )}

            {groups.map((group) => (
              <div key={group.pluginId} className="mb-3">
                {/* Plugin header */}
                <div className="flex items-center gap-2 px-3 py-1">
                  <div
                    className="size-4 flex-shrink-0"
                    dangerouslySetInnerHTML={{ __html: group.logoSvg }}
                    aria-hidden="true"
                  />
                  <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wide">
                    {gtData(group.displayName)}
                  </span>
                </div>

                {/* Accounts under this plugin */}
                {group.accounts.map((account) => {
                  const isExpanded = expanded.has(account.id);
                  const resourceState = accountResources[account.id];
                  const issue = resourceState?.error ?? resourceState?.warning;

                  return (
                    <div key={account.id}>
                      {/* Account row */}
                      <div className="flex items-center w-full px-4 py-1.5 text-sm transition-colors group text-on-surface-secondary hover:bg-surface-overlay hover:text-on-surface">
                        <button
                          type="button"
                          onClick={() => void toggleExpand(account.id)}
                          aria-expanded={isExpanded}
                          aria-controls={`web-sidebar-account-${account.id}`}
                          aria-label={isExpanded ? gt("Collapse account") : gt("Expand account")}
                          className="size-4 flex items-center justify-center flex-shrink-0 text-on-surface-faint hover:text-on-surface-tertiary transition-colors mr-1"
                        >
                          <ChevronIcon
                            direction="right"
                            size={12}
                            className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void navigate({
                              to: "/org/$orgId/accounts/$accountId",
                              params: { orgId: orgId!, accountId: account.id },
                            })
                          }
                          className="flex items-center gap-2 flex-1 text-left min-w-0"
                        >
                          <span className="truncate">{account.displayName}</span>
                          {issue && <IssueIndicator reason={issue} />}
                        </button>
                        {account.oauthStatus === "reconnect_required" && (
                          <ProviderOAuthReconnectBadge
                            accountName={account.displayName}
                            onReconnect={
                              group.oauthAvailable
                                ? () => reconnectAccount(account, group.displayName)
                                : undefined
                            }
                            reconnecting={reconnectingId === account.id}
                          />
                        )}
                      </div>

                      {/* Expanded resources */}
                      {isExpanded && (
                        <div id={`web-sidebar-account-${account.id}`} className="pl-8 pb-1">
                          {resourceState?.loading && (
                            <div className="px-3 py-1 text-xs text-on-surface-faint">
                              {gt("Loading…")}
                            </div>
                          )}
                          {resourceState && !resourceState.loading && resourceState.error && (
                            <div className="px-3 py-1 text-xs text-danger">
                              {gt("Error loading resources")}
                            </div>
                          )}
                          {resourceState &&
                            !resourceState.loading &&
                            !resourceState.error &&
                            resourceState.resources.length === 0 && (
                              <div className="px-3 py-1 text-xs text-on-surface-faint">
                                {gt("No resources")}
                              </div>
                            )}
                          {resourceState?.resources.map((resource) => {
                            const typeMeta = accountTypeMeta[account.id]?.[resource.resourceTypeId];
                            return (
                              <DraggableSidebarResource
                                key={resource.id}
                                resource={{
                                  id: resource.id,
                                  pluginId: resource.pluginId,
                                  resourceTypeId: resource.resourceTypeId,
                                  accountId: resource.accountId,
                                  displayName: resource.displayName,
                                  fields: resource.fieldsJson ?? {},
                                  ...(resource.externalId != null
                                    ? { externalId: resource.externalId }
                                    : {}),
                                  ...(typeMeta?.attachTargets
                                    ? { attachTargets: typeMeta.attachTargets }
                                    : {}),
                                  ...(typeMeta?.isSshHost ? { isSshHost: true } : {}),
                                  ...(typeMeta?.sshTunnelAttachSource
                                    ? { isTunnelSshSource: true }
                                    : {}),
                                }}
                                onClick={() =>
                                  void navigate({
                                    to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
                                    params: {
                                      orgId: orgId!,
                                      pluginId: resource.pluginId,
                                      resourceTypeId: resource.resourceTypeId,
                                      resourceId: resource.id,
                                    },
                                  })
                                }
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Below the accounts tree: when the tree shows it is what the
              person came for, and the apps list is long enough to push it
              out of view. */}
          <SidebarRecentTools tools={orgTools} scope={orgId ?? "none"} />
          <SidebarApps tools={orgTools} settingsFor={settingsFor} />
        </div>

        {/* Manage accounts: every account, and the way to connect another */}
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => setShowManageAccounts(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
          >
            {/* lucide: plug */}
            <svg
              aria-hidden="true"
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="opacity-60"
            >
              <path d="M12 22v-5" />
              <path d="M9 8V2" />
              <path d="M15 8V2" />
              <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
            </svg>
            {gt("Manage accounts")}
          </button>
          <button
            type="button"
            onClick={() => void navigate({ to: "/org/$orgId/settings", params: { orgId: orgId! } })}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
          >
            <SettingsIcon />
            {gt("Settings")}
          </button>
        </div>
      </aside>

      {showManageAccounts && (
        <ManageAccountsModal
          groups={groups}
          onClose={() => setShowManageAccounts(false)}
          onAddAccount={() => setShowAddAccount(true)}
          onOpenAccount={(accountId, displayName) =>
            void navigateToWorkspaceTarget(navigate, accountTabTarget(accountId), {
              label: displayName,
            })
          }
        />
      )}
      {showAddAccount && (
        <AddAccountModal
          onClose={() => setShowAddAccount(false)}
          onAdded={() => useUIStore.getState().bumpAccounts()}
        />
      )}
    </>
  );
}
