import { useState, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "../lib/invoke";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import {
  useUIStore,
  ConfirmDeleteModal,
  RESOURCES_CHANGED_EVENT,
  getListableResourceTypes,
  type DraggableResource,
  formatErrorMessage,
  toast,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import { loadPlugins, getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "../lib/sql-drivers";
import {
  listCloudAccounts,
  listCloudAccountResources,
  syncCloudAccountType,
} from "../lib/cloud-api";
import { SshTunnelModal, type PresetKey } from "./SshTunnelModal";
import { DockerSetupModal } from "./DockerSetupModal";
import { SecretExportModal } from "./SecretExportModal";
import { SshEnvDeployModal } from "./SshEnvDeployModal";
import { MetricPingModal } from "./MetricPingModal";
import {
  accountTabTarget,
  navigateToWorkspaceTarget,
  resourceTabTarget,
} from "../lib/workspace-tabs";

interface Account {
  id: string;
  pluginId: string;
  displayName: string;
  encrypted_credentials: string;
  credentials_iv: string;
  /** True when this account lives in a cloud workspace — credentials are
   * server-side, so decrypt/tunnel/secret-export features are disabled here. */
  cloudManaged?: boolean;
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
  const [accountResources, setAccountResources] = useState<Record<string, AccountResourcesState>>(
    {},
  );
  const [sshEndpointByTypeId, setSshEndpointByTypeId] = useState<
    Record<
      string,
      {
        hostOutputKey: string;
        runningWhen?: { fieldKey: string; value: string };
        defaultUsername?: string;
        usernameFieldKey?: string;
      }
    >
  >({});
  const [kubeconfigTypeIds, setKubeconfigTypeIds] = useState<Set<string>>(new Set());
  const [metricsTypeIds, setMetricsTypeIds] = useState<Set<string>>(new Set());
  const [resourceSshHosts, setResourceSshHosts] = useState<Record<string, string>>({});
  const [resourceSshUsernames, setResourceSshUsernames] = useState<Record<string, string>>({});
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    resourceId: string;
    resourceTypeId: string;
    pluginId: string;
    displayName: string;
    sshHost?: string;
    sshDefaultUsername?: string;
    supportsMetrics: boolean;
    accountId: string;
  } | null>(null);
  const [pingTarget, setPingTarget] = useState<{
    resourceId: string;
    accountId: string;
    pluginId: string;
    resourceTypeId: string;
    displayName: string;
  } | null>(null);
  const [tunnelTarget, setTunnelTarget] = useState<{
    sshHost: string;
    sshDefaultUsername?: string;
    sourceAccountId: string;
    defaultService?: PresetKey;
  } | null>(null);
  const [dockerSetupTarget, setDockerSetupTarget] = useState<{
    sshHost: string;
    sshDefaultUsername?: string;
    sourceAccountId: string;
  } | null>(null);
  const [secretImportPluginIds, setSecretImportPluginIds] = useState<Set<string>>(new Set());
  const [secretExportDrop, setSecretExportDrop] = useState<{
    source: DraggableResource;
    targetPluginId: string;
    targetCredentials: Record<string, string>;
  } | null>(null);
  const [envDeployDrop, setEnvDeployDrop] = useState<{
    source: DraggableResource;
    sshHost: string;
    sshDefaultUsername?: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const navigate = useNavigate();
  const bumpAccounts = useUIStore((s) => s.bumpAccounts);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const workspaceTabs = useUIStore((s) => s.workspaceTabs);
  const connectedAccounts = useUIStore((s) => s.connectedAccounts);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const plugins = await loadPlugins();
        const rows: Array<{
          id: string;
          plugin_id: string;
          display_name: string;
          encrypted_credentials: string;
          credentials_iv: string;
          cloudManaged: boolean;
        }> = [];
        if (activeCloudOrgId) {
          const cloud = await listCloudAccounts(activeCloudOrgId);
          for (const a of cloud) {
            rows.push({
              id: a.id,
              plugin_id: a.pluginId,
              display_name: a.displayName,
              encrypted_credentials: "",
              credentials_iv: "",
              cloudManaged: true,
            });
          }
        } else {
          const db = await getDb();
          const local = await db.select<
            {
              id: string;
              plugin_id: string;
              display_name: string;
              encrypted_credentials: string;
              credentials_iv: string;
            }[]
          >(
            "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts ORDER BY display_name",
          );
          for (const row of local) rows.push({ ...row, cloudManaged: false });
        }

        const pluginMeta = Object.fromEntries(
          plugins.map((p) => [
            p.plugin.manifest.id,
            { displayName: p.plugin.manifest.displayName, logoSvg: p.plugin.manifest.logoSvg },
          ]),
        );

        const sshMap: Record<
          string,
          { hostOutputKey: string; runningWhen?: { fieldKey: string; value: string } }
        > = {};
        for (const p of plugins) {
          for (const rt of p.plugin.resourceTypes) {
            if (rt.sshEndpoint) sshMap[rt.id] = rt.sshEndpoint;
          }
        }
        if (!cancelled) setSshEndpointByTypeId(sshMap);

        const importPlugins = new Set<string>();
        for (const p of plugins) {
          if (p.plugin.manifest.supportsSecretImport) importPlugins.add(p.plugin.manifest.id);
        }
        if (!cancelled) setSecretImportPluginIds(importPlugins);

        const kcTypes = new Set<string>();
        const metricTypes = new Set<string>();
        for (const p of plugins) {
          for (const rt of p.plugin.resourceTypes) {
            if (rt.outputs?.some((o) => o.key === "kubeconfig")) kcTypes.add(rt.id);
            if (rt.supportsMetrics) metricTypes.add(rt.id);
          }
        }
        if (!cancelled) {
          setKubeconfigTypeIds(kcTypes);
          setMetricsTypeIds(metricTypes);
        }

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
            cloudManaged: row.cloudManaged,
          });
        }

        if (!cancelled)
          setGroups(
            [...groupMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
          );
      } catch (e) {
        console.error("SidebarAccounts load error:", e);
        toast.error("Couldn't load sidebar accounts", {
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
  }, [refreshKey, activeCloudOrgId]);

  async function loadAccountResources(account: Account, background = false) {
    const id = account.id;
    if (!background) {
      setAccountResources((prev) => ({
        ...prev,
        [id]: { loading: true, error: null, resources: [] },
      }));
    }
    try {
      let allResources: ResourceInstance[] = [];
      if (account.cloudManaged) {
        if (!activeCloudOrgId) throw new Error("No active cloud workspace");
        const cloudRows = await listCloudAccountResources(activeCloudOrgId, id);
        allResources = cloudRows.map((r) => ({
          id: r.id,
          pluginId: r.pluginId,
          resourceTypeId: r.resourceTypeId,
          accountId: r.accountId,
          displayName: r.displayName,
          fields: JSON.parse(r.fieldsJson || "{}") as Record<string, string | number | boolean>,
          resolvedOutputs: JSON.parse(r.outputsJson || "{}") as Record<string, string>,
          secretStates: [],
          ...(r.externalId ? { externalId: r.externalId } : {}),
          ...(r.parentResourceId ? { parentResourceId: r.parentResourceId } : {}),
          createdAt: "",
          updatedAt: "",
        }));
      } else {
        const credentials = await invoke<Record<string, string>>("account_get_credentials", {
          accountId: account.id,
        });
        const loaded = await getPlugin(account.pluginId);
        if (!loaded) throw new Error(`Plugin "${account.pluginId}" not loaded`);
        const { plugin } = loaded;
        const services = buildPluginHostServices(plugin.manifest, credentials);
        const client = plugin.createClient(credentials, services);
        const topLevelTypes = getListableResourceTypes(plugin.resourceTypes);
        const results = await Promise.allSettled(
          topLevelTypes.map((t) => client.listResources(t.id, id)),
        );
        for (const r of results) {
          if (r.status === "fulfilled") allResources.push(...r.value);
        }
      }
      setAccountResources((prev) => ({
        ...prev,
        [id]: { loading: false, error: null, resources: allResources },
      }));
      const sshHosts: Record<string, string> = {};
      const sshUsernames: Record<string, string> = {};
      // SSH/tunnel features need locally-decryptable credentials.
      if (account.cloudManaged) {
        return;
      }
      for (const r of allResources) {
        const endpoint = sshEndpointByTypeId[r.resourceTypeId];
        if (endpoint) {
          if (endpoint.runningWhen) {
            const fieldVal = String(r.fields[endpoint.runningWhen.fieldKey] ?? "");
            if (fieldVal.toLowerCase() !== endpoint.runningWhen.value.toLowerCase()) continue;
          }
          const host = String(
            r.resolvedOutputs[endpoint.hostOutputKey] ?? r.fields[endpoint.hostOutputKey] ?? "",
          );
          if (host) {
            sshHosts[r.id] = host;
            let username = "";
            if (endpoint.usernameFieldKey) {
              username = String(r.fields[endpoint.usernameFieldKey] ?? "");
            }
            if (!username && endpoint.defaultUsername) {
              username = endpoint.defaultUsername;
            }
            if (username) sshUsernames[r.id] = username;
          }
        }
      }
      if (Object.keys(sshHosts).length > 0) {
        setResourceSshHosts((prev) => ({ ...prev, ...sshHosts }));
      }
      if (Object.keys(sshUsernames).length > 0) {
        setResourceSshUsernames((prev) => ({ ...prev, ...sshUsernames }));
      }
    } catch (e) {
      if (background) return;
      setAccountResources((prev) => ({
        ...prev,
        [id]: {
          loading: false,
          error: formatErrorMessage(e),
          resources: prev[id]?.resources ?? [],
        },
      }));
    }
  }

  async function toggleExpand(account: Account) {
    const id = account.id;
    const isNowExpanded = !expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isNowExpanded) next.add(id);
      else next.delete(id);
      return next;
    });
    if (!isNowExpanded) return;
    if (accountResources[id]) return;
    void loadAccountResources(account);
  }

  async function handleDeleteAccount(account: Account) {
    const db = await getDb();
    // Cascades to resources, dashboard_pins, secret_field_states, ssh_tunnel_configs via FK.
    await db.execute("DELETE FROM accounts WHERE id = $1", [account.id]);
    const tabsToRemove = workspaceTabs
      .filter((tab) => {
        const t = tab.target;
        return (
          (t.kind === "account" && t.accountId === account.id) ||
          (t.kind === "resource" && t.accountId === account.id)
        );
      })
      .map((tab) => tab.id);
    removeWorkspaceTabs(tabsToRemove);
    bumpAccounts();
    setDeleteTarget(null);
  }

  useEffect(() => {
    const id = setInterval(() => {
      const allAccounts = groups.flatMap((g) => g.accounts);
      for (const accountId of expanded) {
        const account = allAccounts.find((a) => a.id === accountId);
        if (account) void loadAccountResources(account, true);
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [groups, expanded]);

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ accountId?: string; resourceTypeId?: string }>).detail;
      const accountId = detail?.accountId;
      const resourceTypeId = detail?.resourceTypeId;
      if (!accountId) {
        for (const id of expanded) {
          const acc = groups.flatMap((g) => g.accounts).find((a) => a.id === id);
          if (acc) void loadAccountResources(acc, true);
        }
        return;
      }
      const account = groups.flatMap((g) => g.accounts).find((a) => a.id === accountId);
      if (!account) return;

      if (!expanded.has(accountId)) {
        setAccountResources((prev) => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        return;
      }

      if (resourceTypeId && account.cloudManaged && activeCloudOrgId) {
        void (async () => {
          try {
            await syncCloudAccountType(activeCloudOrgId, accountId, resourceTypeId);
          } catch {
            // fall through to full reload
          }
          void loadAccountResources(account, true);
        })();
        return;
      }

      void loadAccountResources(account, true);
    }
    window.addEventListener(RESOURCES_CHANGED_EVENT, handler);
    return () => window.removeEventListener(RESOURCES_CHANGED_EVENT, handler);
  }, [groups, expanded, activeCloudOrgId]);

  useEffect(() => {
    function handler(e: Event) {
      const { source, targetId, kind } = (
        e as CustomEvent<{
          source: DraggableResource;
          targetId: string;
          kind: "account" | "resource";
        }>
      ).detail;

      if (kind === "account") {
        const allAccounts = groups.flatMap((g) => g.accounts);
        const account = allAccounts.find((a) => a.id === targetId);
        if (!account || !secretImportPluginIds.has(account.pluginId)) return;
        if (account.cloudManaged) return;
        void (async () => {
          try {
            const creds = await invoke<Record<string, string>>("account_get_credentials", {
              accountId: account.id,
            });
            setSecretExportDrop({
              source,
              targetPluginId: "kubernetes",
              targetCredentials: creds,
            });
          } catch (err) {
            console.error("Failed to resolve credentials for secret drop:", err);
            toast.error("Couldn't resolve credentials", {
              description: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      } else {
        const allResources = Object.values(accountResources).flatMap((s) => s.resources);
        const targetResource = allResources.find((r) => r.id === targetId);
        if (!targetResource) return;

        const sshHost = resourceSshHosts[targetId];
        const sshDefaultUsername = resourceSshUsernames[targetId];
        if (sshHost && !kubeconfigTypeIds.has(targetResource.resourceTypeId)) {
          const TUNNEL_PLUGINS = new Set(["docker", "postgres", "mysql", "redis", "memcached"]);
          const sourcePlugin =
            source.pluginId === "__account__"
              ? String(source.fields["pluginId"] ?? "")
              : source.pluginId;
          if (TUNNEL_PLUGINS.has(sourcePlugin)) {
            const pluginToPreset: Record<string, PresetKey> = {
              docker: "docker",
              postgres: "postgres",
              mysql: "mysql",
              redis: "redis",
              memcached: "memcached",
            };
            setTunnelTarget({
              sshHost,
              ...(sshDefaultUsername ? { sshDefaultUsername } : {}),
              sourceAccountId: targetResource.accountId,
              ...(pluginToPreset[sourcePlugin] !== undefined
                ? { defaultService: pluginToPreset[sourcePlugin] }
                : {}),
            });
          } else {
            setEnvDeployDrop({
              source,
              sshHost,
              ...(sshDefaultUsername ? { sshDefaultUsername } : {}),
            });
          }
          return;
        }

        if (!kubeconfigTypeIds.has(targetResource.resourceTypeId)) return;
        const allAccounts = groups.flatMap((g) => g.accounts);
        const ownerAccount = allAccounts.find((a) => a.id === targetResource.accountId);
        if (!ownerAccount) return;
        if (ownerAccount.cloudManaged) return;
        void (async () => {
          try {
            const ownerCreds = await invoke<Record<string, string>>("account_get_credentials", {
              accountId: ownerAccount.id,
            });
            const loaded = await getPlugin(ownerAccount.pluginId);
            if (!loaded) return;
            const services = buildPluginHostServices(loaded.plugin.manifest, ownerCreds);
            const client = loaded.plugin.createClient(ownerCreds, services);
            const kubeconfig = await client.resolveOutput(
              targetResource.resourceTypeId,
              targetResource.id,
              "kubeconfig",
              targetResource.accountId,
            );
            setSecretExportDrop({
              source,
              targetPluginId: "kubernetes",
              targetCredentials: { kubeconfig },
            });
          } catch (err) {
            console.error("Failed to resolve kubeconfig for secret drop:", err);
            toast.error("Couldn't resolve kubeconfig", {
              description: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }
    }
    window.addEventListener("iw:sidebar-secret-drop", handler);
    return () => window.removeEventListener("iw:sidebar-secret-drop", handler);
  }, [groups, secretImportPluginIds, accountResources, kubeconfigTypeIds]);

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
    return <div className="px-3 py-2 text-xs text-on-surface-faint">Loading…</div>;
  }

  if (groups.length === 0) {
    return null;
  }

  return (
    <>
      <div className="py-1">
        {groups.map((group) => (
          <div key={group.pluginId} className="mb-3">
            <div className="flex items-center gap-2 px-3 py-1">
              <div
                className="w-4 h-4 flex-shrink-0"
                dangerouslySetInnerHTML={{ __html: group.logoSvg }}
              />
              <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wide">
                {group.displayName}
              </span>
            </div>

            {group.accounts.map((account) => {
              const isExpanded = expanded.has(account.id);
              const resourceState = accountResources[account.id];

              return (
                <div key={account.id}>
                  <AccountDraggableRow
                    account={account}
                    group={group}
                    isExpanded={isExpanded}
                    connected={connectedAccounts.has(account.id)}
                    acceptsSecretImport={secretImportPluginIds.has(account.pluginId)}
                    onToggleExpand={() => void toggleExpand(account)}
                    onNavigate={() =>
                      void navigateToWorkspaceTarget(navigate, accountTabTarget(account.id), {
                        label: account.displayName,
                      })
                    }
                    onDelete={account.cloudManaged ? undefined : () => setDeleteTarget(account)}
                  />

                  {isExpanded && (
                    <div className="pl-8 pb-1">
                      {resourceState?.loading && (
                        <div className="px-3 py-1 text-xs text-on-surface-faint">Loading…</div>
                      )}
                      {resourceState?.error && (
                        <div
                          className="px-3 py-1 text-xs text-red-500 truncate"
                          title={resourceState.error}
                        >
                          Error loading resources
                        </div>
                      )}
                      {resourceState &&
                        !resourceState.loading &&
                        !resourceState.error &&
                        resourceState.resources.length === 0 && (
                          <div className="px-3 py-1 text-xs text-on-surface-faint">
                            No resources
                          </div>
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
                        const sshHost = resourceSshHosts[resource.id];
                        const supportsMetrics = metricsTypeIds.has(resource.resourceTypeId);
                        return (
                          <SidebarResourceItem
                            key={resource.id}
                            draggable={draggable}
                            acceptsSecretImport={kubeconfigTypeIds.has(resource.resourceTypeId)}
                            sshHostValue={sshHost}
                            onContextMenu={
                              sshHost || supportsMetrics
                                ? (e) => {
                                    e.preventDefault();
                                    setContextMenu({
                                      x: e.clientX,
                                      y: e.clientY,
                                      resourceId: resource.id,
                                      resourceTypeId: resource.resourceTypeId,
                                      pluginId: resource.pluginId,
                                      displayName: resource.displayName,
                                      ...(sshHost ? { sshHost } : {}),
                                      ...(resourceSshUsernames[resource.id]
                                        ? {
                                            sshDefaultUsername: resourceSshUsernames[resource.id],
                                          }
                                        : {}),
                                      supportsMetrics,
                                      accountId: resource.accountId,
                                    });
                                  }
                                : undefined
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

      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}
          className="bg-surface-overlay border border-border-strong rounded-lg shadow-xl py-1 min-w-[200px]"
        >
          {contextMenu.sshHost && (
            <button
              className="w-full px-3 py-2 text-xs text-on-surface-secondary hover:bg-surface-sunken text-left flex items-center gap-2"
              onClick={() => {
                setTunnelTarget({
                  sshHost: contextMenu.sshHost!,
                  ...(contextMenu.sshDefaultUsername
                    ? { sshDefaultUsername: contextMenu.sshDefaultUsername }
                    : {}),
                  sourceAccountId: contextMenu.accountId,
                });
                setContextMenu(null);
              }}
            >
              <span>⇢</span>
              Connect to service via SSH…
            </button>
          )}
          {contextMenu.sshHost && (
            <button
              className="w-full px-3 py-2 text-xs text-on-surface-secondary hover:bg-surface-sunken text-left flex items-center gap-2"
              onClick={() => {
                setDockerSetupTarget({
                  sshHost: contextMenu.sshHost!,
                  ...(contextMenu.sshDefaultUsername
                    ? { sshDefaultUsername: contextMenu.sshDefaultUsername }
                    : {}),
                  sourceAccountId: contextMenu.accountId,
                });
                setContextMenu(null);
              }}
            >
              <span>🐳</span>
              Setup Docker on VM…
            </button>
          )}
          {contextMenu.supportsMetrics && (
            <button
              className="w-full px-3 py-2 text-xs text-on-surface-secondary hover:bg-surface-sunken text-left flex items-center gap-2"
              onClick={() => {
                setPingTarget({
                  resourceId: contextMenu.resourceId,
                  accountId: contextMenu.accountId,
                  pluginId: contextMenu.pluginId,
                  resourceTypeId: contextMenu.resourceTypeId,
                  displayName: contextMenu.displayName,
                });
                setContextMenu(null);
              }}
            >
              <span>🔔</span>
              Add or remove metric ping…
            </button>
          )}
        </div>
      )}

      {pingTarget && (
        <MetricPingModal
          resourceId={pingTarget.resourceId}
          accountId={pingTarget.accountId}
          pluginId={pingTarget.pluginId}
          resourceTypeId={pingTarget.resourceTypeId}
          resourceDisplayName={pingTarget.displayName}
          onClose={() => setPingTarget(null)}
        />
      )}

      {tunnelTarget && (
        <SshTunnelModal
          sshHost={tunnelTarget.sshHost}
          {...(tunnelTarget.sshDefaultUsername
            ? { defaultUsername: tunnelTarget.sshDefaultUsername }
            : {})}
          sourceAccountId={tunnelTarget.sourceAccountId}
          {...(tunnelTarget.defaultService !== undefined
            ? { defaultService: tunnelTarget.defaultService }
            : {})}
          onClose={() => setTunnelTarget(null)}
          onTunnelEstablished={(newAccountId) => {
            setTunnelTarget(null);
            void navigateToWorkspaceTarget(navigate, accountTabTarget(newAccountId));
          }}
        />
      )}

      {dockerSetupTarget && (
        <DockerSetupModal
          sshHost={dockerSetupTarget.sshHost}
          {...(dockerSetupTarget.sshDefaultUsername
            ? { defaultUsername: dockerSetupTarget.sshDefaultUsername }
            : {})}
          sourceAccountId={dockerSetupTarget.sourceAccountId}
          onClose={() => setDockerSetupTarget(null)}
          onComplete={(newAccountId) => {
            setDockerSetupTarget(null);
            void navigateToWorkspaceTarget(navigate, accountTabTarget(newAccountId));
          }}
        />
      )}

      {envDeployDrop && (
        <SshEnvDeployModal
          source={envDeployDrop.source}
          sshHost={envDeployDrop.sshHost}
          {...(envDeployDrop.sshDefaultUsername
            ? { defaultUsername: envDeployDrop.sshDefaultUsername }
            : {})}
          onClose={() => setEnvDeployDrop(null)}
          onDeployed={() => setEnvDeployDrop(null)}
        />
      )}

      {secretExportDrop && (
        <SecretExportModal
          source={secretExportDrop.source}
          targetPluginId={secretExportDrop.targetPluginId}
          targetCredentials={secretExportDrop.targetCredentials}
          onClose={() => setSecretExportDrop(null)}
          onCreated={() => setSecretExportDrop(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          kind="account"
          name={deleteTarget.displayName}
          onConfirm={() => handleDeleteAccount(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}

function SidebarResourceItem({
  draggable,
  acceptsSecretImport,
  sshHostValue,
  onContextMenu,
}: {
  draggable: DraggableResource;
  acceptsSecretImport?: boolean;
  sshHostValue?: string | undefined;
  onContextMenu?: ((e: React.MouseEvent) => void) | undefined;
}) {
  const navigate = useNavigate();
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `sidebar-${draggable.id}`,
    data: {
      resource: draggable,
      workspaceTabTarget: resourceTabTarget(draggable.accountId, draggable.id),
      dragLabel: draggable.displayName,
    },
  });

  const isDropTarget = !!acceptsSecretImport || !!sshHostValue;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `sidebar-resource:${draggable.id}`,
    disabled: !isDropTarget || isDragging,
  });

  const showDropHint = isOver && isDropTarget;

  function setRefs(node: HTMLDivElement | null) {
    setDragRef(node);
    setDropRef(node);
  }

  return (
    <div
      ref={setRefs}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-2 px-3 py-1 text-xs rounded cursor-pointer transition-colors ${
        showDropHint
          ? "bg-accent-muted text-accent-on-muted ring-1 ring-inset ring-blue-500"
          : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay"
      } ${isDragging ? "opacity-40" : ""}`}
      onClick={() =>
        void navigateToWorkspaceTarget(
          navigate,
          resourceTabTarget(draggable.accountId, draggable.id),
          { label: draggable.displayName },
        )
      }
      onContextMenu={onContextMenu}
    >
      <span className="text-on-surface-faint">⠿</span>
      <span className="truncate">{draggable.displayName}</span>
      {showDropHint && <span className="ml-auto text-accent flex-shrink-0">Drop</span>}
    </div>
  );
}

function AccountDraggableRow({
  account,
  group,
  isExpanded,
  connected,
  acceptsSecretImport,
  onToggleExpand,
  onNavigate,
  onDelete,
}: {
  account: Account;
  group: PluginGroup;
  isExpanded: boolean;
  connected: boolean;
  acceptsSecretImport: boolean;
  onToggleExpand: () => void;
  onNavigate: () => void;
  onDelete?: (() => void) | undefined;
}) {
  const draggableData: DraggableResource = {
    id: account.id,
    pluginId: account.pluginId,
    resourceTypeId: "__account__",
    accountId: account.id,
    displayName: account.displayName,
    fields: { pluginId: account.pluginId, pluginDisplayName: group.displayName },
  };

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `account-${account.id}`,
    data: {
      resource: draggableData,
      workspaceTabTarget: accountTabTarget(account.id),
      dragLabel: account.displayName,
    },
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `sidebar-account:${account.id}`,
    disabled: !acceptsSecretImport || isDragging,
  });

  const showDropHint = isOver && acceptsSecretImport;

  function setRefs(node: HTMLDivElement | null) {
    setDragRef(node);
    setDropRef(node);
  }

  return (
    <div
      ref={setRefs}
      {...listeners}
      {...attributes}
      className={`flex items-center w-full px-4 py-1.5 text-sm transition-colors group cursor-grab active:cursor-grabbing ${
        showDropHint
          ? "bg-accent-muted text-accent-on-muted ring-1 ring-inset ring-blue-500"
          : "text-on-surface-secondary hover:bg-surface-overlay hover:text-on-surface"
      } ${isDragging ? "opacity-40" : ""}`}
    >
      <button
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand();
        }}
        title={isExpanded ? "Collapse" : "Expand resources"}
        className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-on-surface-faint hover:text-on-surface-tertiary transition-colors mr-1"
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
        onClick={(e) => {
          e.stopPropagation();
          onNavigate();
        }}
        className="flex items-center gap-2 flex-1 text-left min-w-0"
      >
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors ${connected ? "bg-blue-400" : "bg-surface-sunken"}`}
        />
        <span className="truncate">{account.displayName}</span>
      </button>
      {showDropHint && <span className="text-xs text-accent flex-shrink-0">Drop</span>}
      {!showDropHint && onDelete && (
        <button
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete account"
          className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-on-surface-faint opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition-all"
        >
          ✕
        </button>
      )}
    </div>
  );
}
