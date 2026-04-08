"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  useUIStore,
  DroppableDashboardItem,
  DraggableSidebarResource,
  type DraggableResource,
} from "@infrawrench/ui";
import { listAccounts, listPlugins, type AccountSummary, type PluginInfo } from "@/actions/accounts";
import { syncResources, listResources, type ResourceSummary } from "@/actions/resources";
import {
  listDashboards,
  createDashboard,
  renameDashboard,
  deleteDashboard,
} from "@/actions/dashboard";
import { AddAccountModal } from "./AddAccountModal";

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

export function WebSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [groups, setGroups] = useState<PluginGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [accountResources, setAccountResources] = useState<
    Record<string, { loading: boolean; resources: ResourceSummary[] }>
  >({});
  const [showAddAccount, setShowAddAccount] = useState(false);

  // Dashboard state
  const [dashboardList, setDashboardList] = useState<DashboardEntry[]>([]);
  const [addingDashboard, setAddingDashboard] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const newDashboardRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const accountsVersion = useUIStore((s) => s.accountsVersion);
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);

  // Load dashboards
  useEffect(() => {
    listDashboards().then(setDashboardList).catch(console.error);
  }, [dashboardPinsVersion]);

  // Load accounts and plugins
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [accts, pluginList] = await Promise.all([listAccounts(), listPlugins()]);
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
    return () => { cancelled = true; };
  }, [accountsVersion]);

  // Focus inputs when they appear
  useEffect(() => {
    if (addingDashboard) newDashboardRef.current?.focus();
  }, [addingDashboard]);

  useEffect(() => {
    if (renamingId) renameRef.current?.focus();
  }, [renamingId]);

  async function handleCreateDashboard() {
    const name = newDashboardName.trim();
    setAddingDashboard(false);
    setNewDashboardName("");
    if (!name) return;
    try {
      const created = await createDashboard({ name });
      if (created) {
        setDashboardList((prev) => [...prev, { id: created.id, name: created.name, isDefault: false }]);
        router.push(`/dashboard/${created.id}`);
      }
    } catch (e) {
      console.error("Failed to create dashboard:", e);
    }
  }

  async function handleRename() {
    const name = renameValue.trim();
    const id = renamingId;
    setRenamingId(null);
    setRenameValue("");
    if (!name || !id) return;
    try {
      await renameDashboard({ id, name });
      setDashboardList((prev) =>
        prev.map((d) => (d.id === id ? { ...d, name } : d)),
      );
    } catch (e) {
      console.error("Failed to rename dashboard:", e);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteDashboard({ id });
      setDashboardList((prev) => prev.filter((d) => d.id !== id));
      if (pathname === `/dashboard/${id}`) {
        router.push("/");
      }
    } catch (e) {
      console.error("Failed to delete dashboard:", e);
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

    setAccountResources((prev) => ({
      ...prev,
      [accountId]: { loading: true, resources: [] },
    }));

    try {
      // Load from DB first (fast), then sync in background and refresh
      const existing = await listResources(accountId);
      setAccountResources((prev) => ({
        ...prev,
        [accountId]: { loading: false, resources: existing },
      }));

      // Background sync — refresh when done
      syncResources(accountId)
        .then(() => listResources(accountId))
        .then((fresh) => {
          setAccountResources((prev) => ({
            ...prev,
            [accountId]: { loading: false, resources: fresh },
          }));
        })
        .catch((e) => console.error("Background sync failed:", e));
    } catch (e) {
      console.error("Failed to load resources:", e);
      setAccountResources((prev) => ({
        ...prev,
        [accountId]: { loading: false, resources: [] },
      }));
    }
  }

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
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
          <span className="text-sm font-semibold text-gray-300">Infrawrench</span>
          <button
            onClick={toggleSidebar}
            className="text-gray-700 hover:text-gray-400 transition-colors text-xs"
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
                onClick={() => setAddingDashboard(true)}
                title="New dashboard"
                className="text-gray-600 hover:text-gray-300 text-sm leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-gray-800 transition-colors"
              >
                +
              </button>
            </div>

            {dashboardList.map((dash) => {
              const isActive = dash.isDefault
                ? pathname === "/"
                : pathname === `/dashboard/${dash.id}`;
              const href = dash.isDefault ? "/" : `/dashboard/${dash.id}`;

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
                  onClick={() => router.push(href)}
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
                  value={newDashboardName}
                  onChange={(e) => setNewDashboardName(e.target.value)}
                  placeholder="Dashboard name..."
                  onBlur={() => void handleCreateDashboard()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateDashboard();
                    if (e.key === "Escape") {
                      setAddingDashboard(false);
                      setNewDashboardName("");
                    }
                  }}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>
            )}
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
                        onClick={() => router.push(`/accounts/${account.id}`)}
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
                        {resourceState && !resourceState.loading && resourceState.resources.length === 0 && (
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
                            onClick={() => router.push(
                              `/resources/${resource.pluginId}/${resource.resourceTypeId}/${encodeURIComponent(resource.id)}`,
                            )}
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
            onClick={() => router.push("/settings")}
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
    </>
  );
}
