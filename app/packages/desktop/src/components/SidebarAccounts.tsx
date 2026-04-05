import { useState, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "../lib/invoke";
import { useDraggable } from "@dnd-kit/core";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { useUIStore } from "@infrawrench/ui";
import { getDb } from "../db/client";
import { loadPlugins, getPlugin } from "../plugins/loader";
import type { DraggableResource } from "../lib/pins";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { SshTunnelModal } from "./SshTunnelModal";

interface Account {
  id: string;
  pluginId: string;
  displayName: string;
  encrypted_credentials: string;
  credentials_iv: string;
}

interface PluginGroup {
  pluginId: string;
  displayName: string;
  logoSvg: string;
  accounts: Account[];
}

interface SidebarAccountsProps {
  /** Increment this to force a refresh */
  refreshKey: number;
}

interface AccountResourcesState {
  loading: boolean;
  error: string | null;
  resources: ResourceInstance[];
}

export function SidebarAccounts({ refreshKey }: SidebarAccountsProps) {
  const [groups, setGroups] = useState<PluginGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [accountResources, setAccountResources] = useState<Record<string, AccountResourcesState>>({});
  // typeId → hostOutputKey for resources with sshEndpoint
  const [sshEndpointByTypeId, setSshEndpointByTypeId] = useState<Record<string, string>>({});
  // resourceId → sshHost value
  const [resourceSshHosts, setResourceSshHosts] = useState<Record<string, string>>({});
  // context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    resourceId: string; sshHost: string; accountId: string;
  } | null>(null);
  // SSH tunnel modal target
  const [tunnelTarget, setTunnelTarget] = useState<{
    sshHost: string; sourceAccountId: string;
  } | null>(null);
  const navigate = useNavigate();
  const connectedAccounts = useUIStore((s) => s.connectedAccounts);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [db, plugins] = await Promise.all([getDb(), loadPlugins()]);
        const rows = await db.select<{
          id: string;
          plugin_id: string;
          display_name: string;
          encrypted_credentials: string;
          credentials_iv: string;
        }[]>(
          "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts ORDER BY display_name",
        );

        const pluginMeta = Object.fromEntries(
          plugins.map((p) => [
            p.plugin.manifest.id,
            { displayName: p.plugin.manifest.displayName, logoSvg: p.plugin.manifest.logoSvg },
          ]),
        );

        // Build sshEndpoint lookup from all resource types
        const sshMap: Record<string, string> = {};
        for (const p of plugins) {
          for (const rt of p.plugin.resourceTypes) {
            if (rt.sshEndpoint) {
              sshMap[rt.id] = rt.sshEndpoint.hostOutputKey;
            }
          }
        }
        if (!cancelled) setSshEndpointByTypeId(sshMap);

        // Group accounts by plugin
        const groupMap = new Map<string, PluginGroup>();
        for (const row of rows) {
          if (!groupMap.has(row.plugin_id)) {
            groupMap.set(row.plugin_id, {
              pluginId: row.plugin_id,
              displayName: pluginMeta[row.plugin_id]?.displayName ?? row.plugin_id,
              logoSvg: pluginMeta[row.plugin_id]?.logoSvg ?? "",
              accounts: [],
            });
          }
          groupMap.get(row.plugin_id)!.accounts.push({
            id: row.id,
            pluginId: row.plugin_id,
            displayName: row.display_name,
            encrypted_credentials: row.encrypted_credentials,
            credentials_iv: row.credentials_iv,
          });
        }

        if (!cancelled) setGroups([...groupMap.values()]);
      } catch (e) {
        console.error("SidebarAccounts load error:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [refreshKey]);

  async function toggleExpand(account: Account) {
    const id = account.id;
    const isNowExpanded = !expanded.has(id);

    setExpanded((prev) => {
      const next = new Set(prev);
      if (isNowExpanded) next.add(id);
      else next.delete(id);
      return next;
    });

    // Only load resources if expanding and not already loaded
    if (!isNowExpanded) return;
    if (accountResources[id]) return;

    setAccountResources((prev) => ({
      ...prev,
      [id]: { loading: true, error: null, resources: [] },
    }));

    try {
      const plaintext = await invoke<string>("decrypt_value", {
        ciphertext: account.encrypted_credentials,
        iv: account.credentials_iv,
      });
      const credentials = JSON.parse(plaintext) as Record<string, string>;
      const loaded = await getPlugin(account.pluginId);
      if (!loaded) throw new Error(`Plugin "${account.pluginId}" not loaded`);
      const { plugin } = loaded;
      const services = buildPluginHostServices(plugin.manifest, credentials);
      const client = plugin.createClient(credentials, services);
      const topLevelTypes = plugin.resourceTypes.filter((t) => !t.parentTypeId);

      const results = await Promise.allSettled(
        topLevelTypes.map((t) => client.listResources(t.id, id)),
      );

      const allResources: ResourceInstance[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") allResources.push(...r.value);
      }

      setAccountResources((prev) => ({
        ...prev,
        [id]: { loading: false, error: null, resources: allResources },
      }));

      // Record SSH host values for resources with sshEndpoint
      const sshHosts: Record<string, string> = {};
      for (const r of allResources) {
        const hostOutputKey = sshEndpointByTypeId[r.resourceTypeId];
        if (hostOutputKey) {
          const host = String(
            r.resolvedOutputs[hostOutputKey] ?? r.fields[hostOutputKey] ?? "",
          );
          if (host) sshHosts[r.id] = host;
        }
      }
      if (Object.keys(sshHosts).length > 0) {
        setResourceSshHosts((prev) => ({ ...prev, ...sshHosts }));
      }
    } catch (e) {
      setAccountResources((prev) => ({
        ...prev,
        [id]: { loading: false, error: String(e), resources: [] },
      }));
    }
  }

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [contextMenu]);

  if (loading) {
    return <div className="px-3 py-2 text-xs text-gray-600">Loading…</div>;
  }

  if (groups.length === 0) {
    return null;
  }

  return (
    <>
    <div className="py-1">
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
                {/* Account row — draggable */}
                <AccountDraggableRow
                  account={account}
                  group={group}
                  isExpanded={isExpanded}
                  connected={connectedAccounts.has(account.id)}
                  onToggleExpand={() => void toggleExpand(account)}
                  onNavigate={() => navigate({ to: "/accounts/$accountId", params: { accountId: account.id } })}
                />

                {/* Expanded resources */}
                {isExpanded && (
                  <div className="pl-8 pb-1">
                    {resourceState?.loading && (
                      <div className="px-3 py-1 text-xs text-gray-600">Loading…</div>
                    )}
                    {resourceState?.error && (
                      <div className="px-3 py-1 text-xs text-red-500 truncate" title={resourceState.error}>
                        Error loading resources
                      </div>
                    )}
                    {resourceState && !resourceState.loading && !resourceState.error && resourceState.resources.length === 0 && (
                      <div className="px-3 py-1 text-xs text-gray-600">No resources</div>
                    )}
                    {resourceState?.resources.map((resource) => {
                      const draggable: DraggableResource = {
                        id: resource.id,
                        pluginId: resource.pluginId,
                        resourceTypeId: resource.resourceTypeId,
                        accountId: resource.accountId,
                        displayName: resource.displayName,
                        fields: resource.fields,
                        externalId: resource.externalId,
                      };
                      return (
                        <SidebarResourceItem
                          key={resource.id}
                          draggable={draggable}
                          sshHostValue={resourceSshHosts[resource.id]}
                          onContextMenuSsh={(e, sshHost) => {
                            e.preventDefault();
                            setContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              resourceId: resource.id,
                              sshHost,
                              accountId: resource.accountId,
                            });
                          }}
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

    {/* Context menu for SSH-accessible resources */}
    {contextMenu && (
      <div
        ref={contextMenuRef}
        style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}
        className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[200px]"
      >
        <button
          className="w-full px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 text-left flex items-center gap-2"
          onClick={() => {
            setTunnelTarget({ sshHost: contextMenu.sshHost, sourceAccountId: contextMenu.accountId });
            setContextMenu(null);
          }}
        >
          <span>⇢</span>
          Connect to service via SSH…
        </button>
      </div>
    )}

    {/* SSH tunnel modal */}
    {tunnelTarget && (
      <SshTunnelModal
        sshHost={tunnelTarget.sshHost}
        sourceAccountId={tunnelTarget.sourceAccountId}
        onClose={() => setTunnelTarget(null)}
        onTunnelEstablished={(newAccountId) => {
          setTunnelTarget(null);
          void navigate({ to: "/accounts/$accountId", params: { accountId: newAccountId } });
        }}
      />
    )}
    </>
  );
}

function SidebarResourceItem({
  draggable,
  sshHostValue,
  onContextMenuSsh,
}: {
  draggable: DraggableResource;
  sshHostValue?: string | undefined;
  onContextMenuSsh?: (e: React.MouseEvent, sshHost: string) => void;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `sidebar-${draggable.id}`,
    data: { resource: draggable },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-2 px-3 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded cursor-pointer transition-colors ${isDragging ? "opacity-40" : ""}`}
      onClick={() => navigate({
        to: "/resource/$accountId/$resourceId",
        params: { accountId: draggable.accountId, resourceId: encodeURIComponent(draggable.id) },
      })}
      onContextMenu={sshHostValue && onContextMenuSsh
        ? (e) => onContextMenuSsh(e, sshHostValue)
        : undefined}
    >
      <span className="text-gray-700">⠿</span>
      <span className="truncate">{draggable.displayName}</span>
    </div>
  );
}

function AccountDraggableRow({
  account,
  group,
  isExpanded,
  connected,
  onToggleExpand,
  onNavigate,
}: {
  account: Account;
  group: PluginGroup;
  isExpanded: boolean;
  connected: boolean;
  onToggleExpand: () => void;
  onNavigate: () => void;
}) {
  const draggableData: DraggableResource = {
    id: account.id,
    pluginId: account.pluginId,
    resourceTypeId: "__account__",
    accountId: account.id,
    displayName: account.displayName,
    fields: { pluginId: account.pluginId, pluginDisplayName: group.displayName },
  };

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `account-${account.id}`,
    data: { resource: draggableData },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex items-center w-full px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-800 hover:text-gray-100 transition-colors group cursor-grab active:cursor-grabbing ${isDragging ? "opacity-40" : ""}`}
    >
      <button
        draggable={false}
        onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
        title={isExpanded ? "Collapse" : "Expand resources"}
        className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-gray-600 hover:text-gray-400 transition-colors mr-1"
      >
        <span
          className="inline-block transition-transform text-xs"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
      </button>
      <button
        draggable={false}
        onClick={(e) => { e.stopPropagation(); onNavigate(); }}
        className="flex items-center gap-2 flex-1 text-left min-w-0"
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors ${connected ? "bg-blue-400" : "bg-gray-600"}`} />
        <span className="truncate">{account.displayName}</span>
      </button>
    </div>
  );
}
