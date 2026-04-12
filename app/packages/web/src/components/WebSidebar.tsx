import { useState, useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  useUIStore,
  DroppableDashboardItem,
  DraggableSidebarResource,
  RESOURCES_CHANGED_EVENT,
  OrgSwitcher,
  Modal,
  type OrgEntry,
} from "@infrawrench/ui";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { AddAccountModal } from "./AddAccountModal";

interface AccountSummary {
  id: string;
  pluginId: string;
  displayName: string;
  createdAt: string;
}

interface ResourceSummary {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
}

interface PluginGroup {
  pluginId: string;
  displayName: string;
  logoSvg: string;
  accounts: AccountSummary[];
}

interface DashboardEntry {
  id: string;
  name: string;
  isDefault: boolean;
}

interface WebSidebarProps {
  orgId: string | null;
}

export function WebSidebar({ orgId }: WebSidebarProps) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [groups, setGroups] = useState<PluginGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [accountResources, setAccountResources] = useState<
    Record<string, { loading: boolean; resources: ResourceSummary[]; error?: string | undefined }>
  >({});
  const [showAddAccount, setShowAddAccount] = useState(false);

  // Dashboard state
  const [dashboardList, setDashboardList] = useState<DashboardEntry[]>([]);
  const [showCreateDashboardModal, setShowCreateDashboardModal] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState("");
  const [creatingDashboard, setCreatingDashboard] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  // Org switcher state
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  const [showCreateOrgModal, setShowCreateOrgModal] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const accountsVersion = useUIStore((s) => s.accountsVersion);
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);

  // Load orgs for the switcher — re-fetch when orgId changes (e.g. after creating a new org)
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
    apiGet<DashboardEntry[]>(`${apiBase}/dashboards`).then(setDashboardList).catch(console.error);
  }, [apiBase, dashboardPinsVersion]);

  useEffect(() => {
    if (!apiBase) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [accts, pluginList] = await Promise.all([
          apiGet<AccountSummary[]>(`${apiBase}/accounts`),
          apiGet<Array<{ id: string; displayName: string; logoSvg: string }>>(
            `${apiBase}/accounts/plugins`,
          ),
        ]);
        if (cancelled) return;

        const pluginMeta = Object.fromEntries(
          pluginList.map((p) => [p.id, { displayName: p.displayName, logoSvg: p.logoSvg }]),
        );

        const groupMap = new Map<string, PluginGroup>();
        for (const acct of accts) {
          if (!groupMap.has(acct.pluginId)) {
            groupMap.set(acct.pluginId, {
              pluginId: acct.pluginId,
              displayName: pluginMeta[acct.pluginId]?.displayName ?? acct.pluginId,
              logoSvg: pluginMeta[acct.pluginId]?.logoSvg ?? "",
              accounts: [],
            });
          }
          groupMap.get(acct.pluginId)!.accounts.push(acct);
        }
        setGroups([...groupMap.values()]);
      } catch (e) {
        console.error("Sidebar load error:", e);
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
    setExpanded(new Set());
    setAccountResources({});
  }, [orgId]);

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
    if (!name) {
      setDashboardError("Name is required");
      return;
    }
    setCreatingDashboard(true);
    setDashboardError(null);
    try {
      const created = await apiPost<{ id: string; name: string }>(`${apiBase}/dashboards`, {
        name,
      });
      if (created) {
        setShowCreateDashboardModal(false);
        setNewDashboardName("");
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
      setDashboardError(e instanceof Error ? e.message : "Failed to create dashboard");
    } finally {
      setCreatingDashboard(false);
    }
  }

  async function handleCreateOrganization() {
    const name = newOrgName.trim();
    if (!name) {
      setOrgError("Organization name is required");
      return;
    }
    setCreatingOrg(true);
    setOrgError(null);
    try {
      const org = await apiPost<{ id: string; displayName: string }>("/api/orgs", {
        displayName: name,
      });
      setShowCreateOrgModal(false);
      setNewOrgName("");
      void navigate({ to: "/org/$orgId", params: { orgId: org.id } });
    } catch (e) {
      setOrgError(e instanceof Error ? e.message : "Failed to create organization");
    } finally {
      setCreatingOrg(false);
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
    }
  }

  async function loadResources(accountId: string, background = false) {
    if (!apiBase) return;
    if (!background) {
      setAccountResources((prev) => ({
        ...prev,
        [accountId]: { loading: true, resources: prev[accountId]?.resources ?? [] },
      }));
    }

    try {
      const [existing] = await Promise.all([
        apiGet<ResourceSummary[]>(`${apiBase}/accounts/${accountId}/resources?topLevelOnly=true`),
        apiPost(`${apiBase}/accounts/${accountId}/sync`)
          .then(() =>
            apiGet<ResourceSummary[]>(
              `${apiBase}/accounts/${accountId}/resources?topLevelOnly=true`,
            ),
          )
          .then((fresh) => {
            setAccountResources((prev) => ({
              ...prev,
              [accountId]: { loading: false, resources: fresh },
            }));
          })
          .catch((e) => console.error("Background sync failed:", e)),
      ]);
      setAccountResources((prev) => ({
        ...prev,
        [accountId]: { loading: false, resources: existing },
      }));
    } catch (e) {
      if (background) return;
      setAccountResources((prev) => ({
        ...prev,
        [accountId]: {
          loading: false,
          resources: [],
          error: e instanceof Error ? e.message : "Failed to load resources",
        },
      }));
    }
  }

  async function toggleExpand(accountId: string) {
    const isNowExpanded = !expanded.has(accountId);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isNowExpanded) next.add(accountId);
      else next.delete(accountId);
      return next;
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
        onClick={toggleSidebar}
        className="w-8 border-r border-gray-800 flex items-center justify-center text-gray-700 hover:text-gray-400 transition-colors flex-shrink-0"
        aria-label="Expand sidebar"
      >
        &#9654;
      </button>
    );
  }

  return (
    <>
      <aside className="w-60 border-r border-gray-800 flex flex-col overflow-hidden flex-shrink-0">
        <div className="flex items-center justify-between px-1 py-1 border-b border-gray-800">
          <div className="flex-1 min-w-0">
            <OrgSwitcher
              orgs={orgs}
              activeOrgId={orgId}
              onSwitch={handleOrgSwitch}
              onCreateOrg={() => {
                setOrgError(null);
                setNewOrgName("");
                setShowCreateOrgModal(true);
              }}
              loading={!orgsLoaded}
            />
          </div>
          <button
            onClick={toggleSidebar}
            className="text-gray-700 hover:text-gray-400 transition-colors text-xs px-2"
            aria-label="Collapse sidebar"
          >
            &#9664;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {/* Dashboards section */}
          <div className="mb-2">
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                Dashboards
              </span>
              <button
                onClick={() => {
                  setDashboardError(null);
                  setNewDashboardName("");
                  setShowCreateDashboardModal(true);
                }}
                title="New dashboard"
                className="text-gray-600 hover:text-gray-300 text-sm leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-gray-800 transition-colors"
              >
                +
              </button>
            </div>

            {dashboardList.map((dash) => {
              const dashHref = dash.isDefault
                ? `/org/${orgId}`
                : `/org/${orgId}/dashboard/${dash.id}`;
              const isActive = dash.isDefault
                ? pathname === `/org/${orgId}` || pathname === `/org/${orgId}/`
                : pathname === `/org/${orgId}/dashboard/${dash.id}`;

              if (renamingId === dash.id) {
                return (
                  <div key={dash.id} className="mx-2 px-3 py-1">
                    <input
                      ref={renameRef}
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
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
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
          </div>

          {/* Plugin groups */}
          {loading && <div className="px-3 py-2 text-xs text-gray-600">Loading...</div>}

          {groups.map((group) => (
            <div key={group.pluginId} className="mb-3">
              {/* Plugin header */}
              <div className="flex items-center gap-2 px-3 py-1">
                <div
                  className="w-4 h-4 flex-shrink-0"
                  dangerouslySetInnerHTML={{ __html: group.logoSvg }}
                />
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {group.displayName}
                </span>
              </div>

              {/* Accounts under this plugin */}
              {group.accounts.map((account) => {
                const isExpanded = expanded.has(account.id);
                const resourceState = accountResources[account.id];

                return (
                  <div key={account.id}>
                    {/* Account row */}
                    <div className="flex items-center w-full px-4 py-1.5 text-sm transition-colors group text-gray-300 hover:bg-gray-800 hover:text-gray-100">
                      <button
                        onClick={() => void toggleExpand(account.id)}
                        className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-gray-600 hover:text-gray-400 transition-colors mr-1"
                      >
                        <span
                          className="inline-block transition-transform text-xs"
                          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                        >
                          &#9654;
                        </span>
                      </button>
                      <button
                        onClick={() =>
                          void navigate({
                            to: "/org/$orgId/accounts/$accountId",
                            params: { orgId: orgId!, accountId: account.id },
                          })
                        }
                        className="flex items-center gap-2 flex-1 text-left min-w-0"
                      >
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-gray-600" />
                        <span className="truncate">{account.displayName}</span>
                      </button>
                    </div>

                    {/* Expanded resources */}
                    {isExpanded && (
                      <div className="pl-8 pb-1">
                        {resourceState?.loading && (
                          <div className="px-3 py-1 text-xs text-gray-600">Loading...</div>
                        )}
                        {resourceState && !resourceState.loading && resourceState.error && (
                          <div className="px-3 py-1 text-xs text-red-400">
                            Error loading resources
                          </div>
                        )}
                        {resourceState &&
                          !resourceState.loading &&
                          !resourceState.error &&
                          resourceState.resources.length === 0 && (
                            <div className="px-3 py-1 text-xs text-gray-600">No resources</div>
                          )}
                        {resourceState?.resources.map((resource) => (
                          <DraggableSidebarResource
                            key={resource.id}
                            resource={{
                              id: resource.id,
                              pluginId: resource.pluginId,
                              resourceTypeId: resource.resourceTypeId,
                              accountId: resource.accountId,
                              displayName: resource.displayName,
                              fields: {},
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
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
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
          <button
            onClick={() => void navigate({ to: "/org/$orgId/settings", params: { orgId: orgId! } })}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
          >
            <span className="text-base leading-none">&#9881;</span>
            Settings
          </button>
        </div>
      </aside>

      {showAddAccount && (
        <AddAccountModal
          onClose={() => setShowAddAccount(false)}
          onAdded={() => useUIStore.getState().bumpAccounts()}
        />
      )}

      {showCreateDashboardModal && (
        <Modal
          onClose={() => {
            if (creatingDashboard) return;
            setShowCreateDashboardModal(false);
            setDashboardError(null);
          }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-200">Create dashboard</h2>
              <button
                onClick={() => {
                  if (creatingDashboard) return;
                  setShowCreateDashboardModal(false);
                  setDashboardError(null);
                }}
                className="text-gray-600 hover:text-gray-400 text-lg"
              >
                &#215;
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Name</label>
                <input
                  value={newDashboardName}
                  onChange={(e) => setNewDashboardName(e.target.value)}
                  placeholder="Operations dashboard"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateDashboard();
                    if (e.key === "Escape" && !creatingDashboard) {
                      setShowCreateDashboardModal(false);
                      setDashboardError(null);
                    }
                  }}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                />
              </div>
              {dashboardError && <p className="text-xs text-red-400">{dashboardError}</p>}
              <button
                onClick={() => void handleCreateDashboard()}
                disabled={creatingDashboard}
                className="w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {creatingDashboard ? "Creating..." : "Create dashboard"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showCreateOrgModal && (
        <Modal
          onClose={() => {
            if (creatingOrg) return;
            setShowCreateOrgModal(false);
            setOrgError(null);
          }}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-200">Create organization</h2>
              <button
                onClick={() => {
                  if (creatingOrg) return;
                  setShowCreateOrgModal(false);
                  setOrgError(null);
                }}
                className="text-gray-600 hover:text-gray-400 text-lg"
              >
                &#215;
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Organization name</label>
                <input
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder="My Company"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateOrganization();
                    if (e.key === "Escape" && !creatingOrg) {
                      setShowCreateOrgModal(false);
                      setOrgError(null);
                    }
                  }}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                />
              </div>
              {orgError && <p className="text-xs text-red-400">{orgError}</p>}
              <button
                onClick={() => void handleCreateOrganization()}
                disabled={creatingOrg}
                className="w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {creatingOrg ? "Creating..." : "Create organization"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
