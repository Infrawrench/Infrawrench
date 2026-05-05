import { useState, useEffect, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { invoke } from "../lib/invoke";
import { useDraggable, useDroppable, useDndContext } from "@dnd-kit/core";
import type { ResourceInstance, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import {
  useUIStore,
  ConfirmDeleteModal,
  RESOURCES_CHANGED_EVENT,
  dispatchResourcesChanged,
  AccountResourceSections,
  type DraggableResource,
  formatErrorMessage,
  toast,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import type { AccountRow } from "../db/rows";
import { getPlugin } from "../plugins/loader";
import { pinResource } from "../lib/pins";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { createPluginClient } from "../lib/plugin-client";
import {
  getCloudAccountDetail,
  listCloudAccountResources,
  deleteCloudAccount,
  pinCloudResource,
  unpinCloudResource,
  listCloudDashboards,
  createCloudDashboard,
} from "../lib/cloud-api";
import { CreateResourceModal } from "../components/CreateResourceModal";
import { SecretExportModal } from "../components/SecretExportModal";
import { SshTunnelModal, type PresetKey } from "../components/SshTunnelModal";
import { DockerSetupModal } from "../components/DockerSetupModal";
import { SshEnvDeployModal } from "../components/SshEnvDeployModal";
import { MetricPingModal } from "../components/MetricPingModal";
import {
  navigateToWorkspaceTarget,
  resourceTabTarget,
  accountTabTarget,
} from "../lib/workspace-tabs";

export const Route = createFileRoute("/accounts/$accountId")({
  component: AccountPage,
});

interface CategoryState {
  typeDef: ResourceTypeDefinition;
  loading: boolean;
  error: string | null;
  resources: ResourceInstance[];
}

function AccountPage() {
  const { accountId } = Route.useParams();
  const navigate = useNavigate();
  const bumpAccounts = useUIStore((s) => s.bumpAccounts);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [account, setAccount] = useState<AccountRow | null>(null);
  const [categories, setCategories] = useState<CategoryState[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createTarget, setCreateTarget] = useState<ResourceTypeDefinition | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const backgroundLoadRef = useRef(false);
  const [kubeconfigTypeIds, setKubeconfigTypeIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sshHost?: string;
    sshDefaultUsername?: string;
    pingTarget?: {
      resourceId: string;
      pluginId: string;
      resourceTypeId: string;
      displayName: string;
    };
  } | null>(null);
  const [pingModalTarget, setPingModalTarget] = useState<{
    resourceId: string;
    pluginId: string;
    resourceTypeId: string;
    displayName: string;
  } | null>(null);
  const [tunnelTarget, setTunnelTarget] = useState<{
    sshHost: string;
    sshDefaultUsername?: string;
    defaultService?: PresetKey;
  } | null>(null);
  const [dockerSetupTarget, setDockerSetupTarget] = useState<{
    sshHost: string;
    sshDefaultUsername?: string;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ accountId?: string; resourceTypeId?: string }>).detail;
      if (detail?.accountId && detail.accountId !== accountId) return;
      backgroundLoadRef.current = true;
      setLoadVersion((v) => v + 1);
    }
    window.addEventListener(RESOURCES_CHANGED_EVENT, handler);
    return () => window.removeEventListener(RESOURCES_CHANGED_EVENT, handler);
  }, [accountId]);

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

  useEffect(() => {
    function handler(e: Event) {
      const { source, targetId, kind } = (
        e as CustomEvent<{
          source: DraggableResource;
          targetId: string;
          kind: string;
        }>
      ).detail;
      if (kind !== "resource") return;
      const targetResource = categories.flatMap((c) => c.resources).find((r) => r.id === targetId);
      if (!targetResource) return;

      const targetCategory = categories.find((c) => c.resources.some((r) => r.id === targetId));
      const sshEndpoint = targetCategory?.typeDef.sshEndpoint;
      if (sshEndpoint && !kubeconfigTypeIds.has(targetResource.resourceTypeId)) {
        // Check runningWhen guard
        let vmRunning = true;
        if (sshEndpoint.runningWhen) {
          const fieldVal = String(targetResource.fields[sshEndpoint.runningWhen.fieldKey] ?? "");
          vmRunning = fieldVal.toLowerCase() === sshEndpoint.runningWhen.value.toLowerCase();
        }
        const sshHost = vmRunning
          ? String(
              targetResource.resolvedOutputs?.[sshEndpoint.hostOutputKey] ??
                targetResource.fields[sshEndpoint.hostOutputKey] ??
                "",
            )
          : "";
        if (sshHost) {
          // Resolve SSH username from sshEndpoint declaration
          let sshDefaultUsername: string | undefined;
          if (sshEndpoint.usernameFieldKey) {
            const val = String(targetResource.fields[sshEndpoint.usernameFieldKey] ?? "");
            if (val) sshDefaultUsername = val;
          }
          if (!sshDefaultUsername && sshEndpoint.defaultUsername) {
            sshDefaultUsername = sshEndpoint.defaultUsername;
          }

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
      }

      if (!kubeconfigTypeIds.has(targetResource.resourceTypeId)) return;
      if (!account) return;
      void (async () => {
        try {
          const plaintext = await invoke<string>("decrypt_value", {
            ciphertext: account.encrypted_credentials,
            iv: account.credentials_iv,
          });
          const ownerCreds = JSON.parse(plaintext) as Record<string, string>;
          const loaded = await getPlugin(account.plugin_id);
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
    window.addEventListener("iw:sidebar-secret-drop", handler);
    return () => window.removeEventListener("iw:sidebar-secret-drop", handler);
  }, [categories, kubeconfigTypeIds, account]);

  useEffect(() => {
    function handler(e: Event) {
      const { source, target } = (
        e as CustomEvent<{ source: DraggableResource; target: DraggableResource }>
      ).detail;
      if (source.accountId !== accountId) return;
      void (async () => {
        try {
          const client = await createPluginClient(accountId, source.pluginId);
          if (!client.attachResource) {
            throw new Error("Plugin does not support attach");
          }
          await client.attachResource(
            source.resourceTypeId,
            source.externalId ?? source.id,
            target.resourceTypeId,
            target.externalId ?? target.id,
            accountId,
          );
          dispatchResourcesChanged();
        } catch (err) {
          console.error("Failed to attach resource:", err);
          toast.error("Attach failed", {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }
    window.addEventListener("iw:resource-attach", handler);
    return () => window.removeEventListener("iw:resource-attach", handler);
  }, [accountId]);

  useEffect(() => {
    const id = setInterval(() => {
      backgroundLoadRef.current = true;
      setLoadVersion((v) => v + 1);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isBackground = backgroundLoadRef.current;
    backgroundLoadRef.current = false;
    async function load() {
      if (!isBackground) {
        setInitialLoading(true);
        setError(null);
      }
      try {
        const orgId = useUIStore.getState().activeCloudOrgId;

        if (orgId) {
          // Cloud account detail — no local decrypt, no local plugin client.
          const detail = await getCloudAccountDetail(orgId, accountId);
          if (!detail) throw new Error("Account not found");
          const accountLike: AccountRow = {
            id: detail.account.id,
            plugin_id: detail.account.pluginId,
            display_name: detail.account.displayName,
            encrypted_credentials: "",
            credentials_iv: "",
          };
          if (!cancelled) {
            setAccount(accountLike);
            const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
            if (activeWorkspaceTabId)
              setWorkspaceTabTitle(activeWorkspaceTabId, detail.account.displayName);
          }

          // Load full plugin locally to get full ResourceTypeDefinitions (sshEndpoint, outputs, etc.)
          const loaded = await getPlugin(detail.account.pluginId);
          const allTypes: ResourceTypeDefinition[] = loaded?.plugin.resourceTypes ?? [];

          const kcTypes = new Set<string>();
          for (const rt of allTypes) {
            if (rt.outputs?.some((o) => o.key === "kubeconfig")) kcTypes.add(rt.id);
          }
          if (!cancelled) setKubeconfigTypeIds(kcTypes);

          if (!isBackground && !cancelled) {
            setCategories(
              allTypes.map((t) => ({ typeDef: t, loading: true, error: null, resources: [] })),
            );
            setInitialLoading(false);
          }

          // Single DB read from the cloud — the poller keeps it fresh. No
          // per-type provider calls.
          listCloudAccountResources(orgId, accountId)
            .then((rows) => {
              if (cancelled) return;
              const byType = new Map<string, ResourceInstance[]>();
              for (const r of rows) {
                const fields =
                  typeof r.fieldsJson === "string"
                    ? (JSON.parse(r.fieldsJson) as Record<string, string | number | boolean>)
                    : ((r.fieldsJson ?? {}) as Record<string, string | number | boolean>);
                const outputs =
                  typeof r.outputsJson === "string"
                    ? (JSON.parse(r.outputsJson) as Record<string, string>)
                    : ((r.outputsJson ?? {}) as Record<string, string>);
                const instance: ResourceInstance = {
                  id: r.id,
                  pluginId: r.pluginId,
                  resourceTypeId: r.resourceTypeId,
                  accountId: accountId,
                  displayName: r.displayName,
                  fields,
                  resolvedOutputs: outputs,
                  secretStates: [],
                  ...(r.externalId ? { externalId: r.externalId } : {}),
                  ...(r.parentResourceId ? { parentResourceId: r.parentResourceId } : {}),
                  createdAt: "",
                  updatedAt: "",
                };
                const list = byType.get(r.resourceTypeId) ?? [];
                list.push(instance);
                byType.set(r.resourceTypeId, list);
              }
              setCategories((prev) =>
                prev.map((cat) => ({
                  ...cat,
                  loading: false,
                  error: null,
                  resources: byType.get(cat.typeDef.id) ?? [],
                })),
              );
            })
            .catch((err) => {
              if (cancelled) return;
              if (isBackground) {
                setCategories((prev) => prev.map((cat) => ({ ...cat, loading: false })));
              } else {
                setCategories((prev) =>
                  prev.map((cat) => ({
                    ...cat,
                    loading: false,
                    error: formatErrorMessage(err),
                  })),
                );
              }
            });

          // Cloud pin-state visual — the server doesn't have a "pins by account"
          // endpoint; toggling still works. Leave empty; togglePin updates optimistically.
          if (!cancelled) setPinned(new Set());
          return;
        }

        const db = await getDb();
        const rows = await db.select<AccountRow[]>(
          "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
          [accountId],
        );
        const row = rows[0];
        if (!row) throw new Error("Account not found");
        if (!cancelled) {
          setAccount(row);
          const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
          if (activeWorkspaceTabId) setWorkspaceTabTitle(activeWorkspaceTabId, row.display_name);
        }

        const plaintext = await invoke<string>("decrypt_value", {
          ciphertext: row.encrypted_credentials,
          iv: row.credentials_iv,
        });
        const credentials = JSON.parse(plaintext) as Record<string, string>;

        const loaded = await getPlugin(row.plugin_id);
        if (!loaded) throw new Error(`Plugin "${row.plugin_id}" not loaded`);
        const { plugin } = loaded;
        const services = buildPluginHostServices(plugin.manifest, credentials);
        const client = plugin.createClient(credentials, services);
        const allTypes = plugin.resourceTypes;

        const kcTypes = new Set<string>();
        for (const rt of allTypes) {
          if (rt.outputs?.some((o) => o.key === "kubeconfig")) kcTypes.add(rt.id);
        }
        if (!cancelled) setKubeconfigTypeIds(kcTypes);

        // On foreground load, show category headers immediately with loading skeletons
        if (!isBackground && !cancelled) {
          setCategories(
            allTypes.map((t) => ({
              typeDef: t,
              loading: true,
              error: null,
              resources: [],
            })),
          );
          setInitialLoading(false);
        }

        // Fire off independent async loads per category
        for (const typeDef of allTypes) {
          client
            .listResources(typeDef.id, accountId)
            .then((resources) => {
              if (cancelled) return;
              setCategories((prev) =>
                prev.map((cat) =>
                  cat.typeDef.id === typeDef.id
                    ? { ...cat, loading: false, error: null, resources }
                    : cat,
                ),
              );
            })
            .catch((err) => {
              if (cancelled) return;
              if (isBackground) {
                // Background refresh: silently clear loading, keep stale data
                setCategories((prev) =>
                  prev.map((cat) =>
                    cat.typeDef.id === typeDef.id ? { ...cat, loading: false } : cat,
                  ),
                );
              } else {
                // Foreground: show error, but keep the category visible if it supports create
                setCategories((prev) =>
                  prev.map((cat) =>
                    cat.typeDef.id === typeDef.id
                      ? { ...cat, loading: false, error: formatErrorMessage(err) }
                      : cat,
                  ),
                );
              }
            });
        }

        const pins = await db.select<{ resource_id: string }[]>(
          "SELECT resource_id FROM dashboard_pins",
        );
        if (!cancelled) setPinned(new Set(pins.map((p) => p.resource_id)));
      } catch (e) {
        if (!cancelled && !isBackground) {
          setError(formatErrorMessage(e));
          setInitialLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [accountId, loadVersion]);

  async function togglePin(resource: ResourceInstance, typeId: string) {
    if (activeCloudOrgId) {
      if (pinned.has(resource.id)) {
        // Unpin from all dashboards in this org (best-effort per-dashboard).
        const dashboards = await listCloudDashboards(activeCloudOrgId).catch(() => []);
        await Promise.all(
          dashboards.map((d) =>
            unpinCloudResource(activeCloudOrgId, d.id, resource.id).catch(() => undefined),
          ),
        );
        setPinned((prev) => {
          const s = new Set(prev);
          s.delete(resource.id);
          return s;
        });
      } else {
        let dashboards = await listCloudDashboards(activeCloudOrgId).catch(() => []);
        let home = dashboards.find((d) => d.isDefault);
        if (!home) {
          const created = await createCloudDashboard(activeCloudOrgId, "Home").catch(() => null);
          if (created) home = { ...created, isDefault: true };
          else dashboards = await listCloudDashboards(activeCloudOrgId).catch(() => []);
          home = home ?? dashboards[0];
        }
        if (home) {
          await pinCloudResource(activeCloudOrgId, home.id, resource.id);
          setPinned((prev) => new Set(prev).add(resource.id));
        }
      }
      return;
    }
    const db = await getDb();
    if (pinned.has(resource.id)) {
      await db.execute("DELETE FROM dashboard_pins WHERE resource_id = $1", [resource.id]);
      await db.execute("DELETE FROM resources WHERE id = $1", [resource.id]);
      setPinned((prev) => {
        const s = new Set(prev);
        s.delete(resource.id);
        return s;
      });
    } else {
      // Upsert resource so dashboard_pins FK is satisfied
      await db.execute(
        `INSERT OR REPLACE INTO resources
         (id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          resource.id,
          resource.pluginId,
          typeId,
          resource.accountId,
          resource.displayName,
          resource.externalId ?? resource.id,
          JSON.stringify(resource.fields),
        ],
      );

      // Ensure a default dashboard exists
      const dashboards = await db.select<{ id: string }[]>(
        "SELECT id FROM dashboards WHERE is_default = 1 LIMIT 1",
      );
      let dashId: string;
      if (dashboards.length > 0 && dashboards[0]) {
        dashId = dashboards[0].id;
      } else {
        dashId = crypto.randomUUID();
        await db.execute("INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 1)", [
          dashId,
          "Home",
        ]);
      }

      await db.execute(
        "INSERT OR IGNORE INTO dashboard_pins (id, dashboard_id, resource_id) VALUES ($1, $2, $3)",
        [crypto.randomUUID(), dashId, resource.id],
      );
      setPinned((prev) => new Set(prev).add(resource.id));
    }
  }

  async function deleteAccount() {
    if (activeCloudOrgId) {
      await deleteCloudAccount(activeCloudOrgId, accountId);
    } else {
      const db = await getDb();
      // Cascade deletes resources, dashboard_pins, secret_field_states, ssh_tunnel_configs via FK
      await db.execute("DELETE FROM accounts WHERE id = $1", [accountId]);
    }
    removeWorkspaceTabs(
      useUIStore
        .getState()
        .workspaceTabs.filter(
          (tab) =>
            (tab.target.kind === "account" && tab.target.accountId === accountId) ||
            (tab.target.kind === "resource" && tab.target.accountId === accountId),
        )
        .map((tab) => tab.id),
    );
    bumpAccounts();
    navigate({ to: "/" });
  }

  function openDetail(resource: ResourceInstance) {
    void navigateToWorkspaceTarget(navigate, resourceTabTarget(accountId, resource.id), {
      label: resource.displayName,
    });
  }

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
        Loading…
      </div>
    );
  }
  if (error) {
    return <div className="p-6 text-red-400 text-sm">{error}</div>;
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">{account?.display_name}</h1>
          <p className="text-xs text-on-surface-muted mt-0.5">{account?.plugin_id}</p>
        </div>
        <button
          onClick={() => setConfirmDelete(true)}
          className="text-xs text-on-surface-faint hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
        >
          Remove account
        </button>
      </div>

      <AccountResourceSections
        categories={categories}
        renderResource={(resource, cat) => (
          <ResourcePill
            key={resource.id}
            resource={resource}
            typeId={cat.typeDef.id}
            {...(cat.typeDef.attachTargets ? { attachTargets: cat.typeDef.attachTargets } : {})}
            pinned={pinned.has(resource.id)}
            acceptsSecretImport={kubeconfigTypeIds.has(cat.typeDef.id)}
            {...(cat.typeDef.sshEndpoint
              ? {
                  sshHostOutputKey: cat.typeDef.sshEndpoint.hostOutputKey,
                  sshRunningWhen: cat.typeDef.sshEndpoint.runningWhen,
                }
              : {})}
            onPin={() => togglePin(resource, cat.typeDef.id)}
            onOpen={() => openDetail(resource)}
            supportsMetrics={!!cat.typeDef.supportsMetrics}
            onContextMenuOpen={(e, sshHost) => {
              e.preventDefault();
              // Resolve SSH username from the resource type's sshEndpoint
              let sshDefaultUsername: string | undefined;
              const ep = cat.typeDef.sshEndpoint;
              if (ep?.usernameFieldKey) {
                const val = String(resource.fields[ep.usernameFieldKey] ?? "");
                if (val) sshDefaultUsername = val;
              }
              if (!sshDefaultUsername && ep?.defaultUsername) {
                sshDefaultUsername = ep.defaultUsername;
              }
              setContextMenu({
                x: e.clientX,
                y: e.clientY,
                ...(sshHost ? { sshHost } : {}),
                ...(sshDefaultUsername ? { sshDefaultUsername } : {}),
                ...(cat.typeDef.supportsMetrics
                  ? {
                      pingTarget: {
                        resourceId: resource.id,
                        pluginId: resource.pluginId,
                        resourceTypeId: cat.typeDef.id,
                        displayName: resource.displayName,
                      },
                    }
                  : {}),
              });
            }}
          />
        )}
        renderCreateButton={(typeDef) => (
          <button
            key={`create-${typeDef.id}`}
            onClick={() => setCreateTarget(typeDef)}
            className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-border-strong text-on-surface-faint hover:border-blue-600 hover:text-accent transition-colors text-sm"
          >
            <span className="text-base leading-none">+</span>
            <span>Create {typeDef.displayName}</span>
          </button>
        )}
      />

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

      {createTarget && account && (
        <CreateResourceModal
          accountId={accountId}
          pluginId={account.plugin_id}
          resourceType={createTarget}
          onClose={() => setCreateTarget(null)}
          onCreated={(resource) => {
            const childTypeId = createTarget.id;
            setCreateTarget(null);
            dispatchResourcesChanged({ accountId, resourceTypeId: childTypeId });
            void navigateToWorkspaceTarget(navigate, resourceTabTarget(accountId, resource.id), {
              label: resource.displayName,
            });
          }}
        />
      )}

      {/* Resource context menu */}
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
                });
                setContextMenu(null);
              }}
            >
              <span>🐳</span>
              Setup Docker on VM…
            </button>
          )}
          {contextMenu.pingTarget && (
            <button
              className="w-full px-3 py-2 text-xs text-on-surface-secondary hover:bg-surface-sunken text-left flex items-center gap-2"
              onClick={() => {
                setPingModalTarget(contextMenu.pingTarget!);
                setContextMenu(null);
              }}
            >
              <span>🔔</span>
              Add or remove metric ping…
            </button>
          )}
        </div>
      )}

      {pingModalTarget && (
        <MetricPingModal
          resourceId={pingModalTarget.resourceId}
          accountId={accountId}
          pluginId={pingModalTarget.pluginId}
          resourceTypeId={pingModalTarget.resourceTypeId}
          resourceDisplayName={pingModalTarget.displayName}
          onClose={() => setPingModalTarget(null)}
        />
      )}

      {tunnelTarget && (
        <SshTunnelModal
          sshHost={tunnelTarget.sshHost}
          {...(tunnelTarget.sshDefaultUsername
            ? { defaultUsername: tunnelTarget.sshDefaultUsername }
            : {})}
          sourceAccountId={accountId}
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
          sourceAccountId={accountId}
          onClose={() => setDockerSetupTarget(null)}
          onComplete={(newAccountId) => {
            setDockerSetupTarget(null);
            void navigateToWorkspaceTarget(navigate, accountTabTarget(newAccountId));
          }}
        />
      )}

      {confirmDelete && account && (
        <ConfirmDeleteModal
          kind="account"
          name={account.display_name}
          onConfirm={() => deleteAccount()}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function ResourcePill({
  resource,
  typeId,
  attachTargets,
  pinned,
  acceptsSecretImport,
  sshHostOutputKey,
  sshRunningWhen,
  supportsMetrics,
  onPin,
  onOpen,
  onContextMenuOpen,
}: {
  resource: ResourceInstance;
  typeId: string;
  attachTargets?: import("@infrawrench/plugin-base").AttachTarget[] | undefined;
  pinned: boolean;
  acceptsSecretImport?: boolean;
  sshHostOutputKey?: string;
  sshRunningWhen?: { fieldKey: string; value: string };
  supportsMetrics?: boolean;
  onPin: () => void;
  onOpen: () => void;
  onContextMenuOpen?: (e: React.MouseEvent, sshHost: string) => void;
}) {
  const subtitle = String(
    resource.fields["host"] ?? resource.fields["region"] ?? resource.fields["engine"] ?? "",
  );

  const draggableData: DraggableResource = {
    id: resource.id,
    pluginId: resource.pluginId,
    resourceTypeId: typeId,
    accountId: resource.accountId,
    displayName: resource.displayName,
    fields: resource.fields,
    externalId: resource.externalId,
    ...(attachTargets && attachTargets.length > 0 ? { attachTargets } : {}),
  };

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: resource.id,
    data: { resource: draggableData },
  });

  let sshHost = "";
  if (sshHostOutputKey) {
    let isRunning = true;
    if (sshRunningWhen) {
      const fieldVal = String(resource.fields[sshRunningWhen.fieldKey] ?? "");
      isRunning = fieldVal.toLowerCase() === sshRunningWhen.value.toLowerCase();
    }
    if (isRunning) {
      sshHost = String(
        resource.resolvedOutputs?.[sshHostOutputKey] ?? resource.fields[sshHostOutputKey] ?? "",
      );
    }
  }

  // Separate droppable from draggable — combining refs on the same node in a
  // flex-wrap layout causes @dnd-kit to lose rect measurements during drag.
  const { active } = useDndContext();
  const activeResource = active?.data.current?.resource as DraggableResource | undefined;
  const sameCluster = activeResource?.accountId === resource.accountId;
  // Secret-import drops require a *different* account; attach drops require the *same* account.
  const secretDropOk = (!!acceptsSecretImport || !!sshHost) && !sameCluster;
  const attachMatch = activeResource?.attachTargets?.find(
    (t) => t.pluginId === resource.pluginId && t.resourceTypeId === typeId,
  );
  const attachDropOk =
    sameCluster &&
    !!attachMatch &&
    activeResource?.id !== resource.id &&
    (!attachMatch.matchField ||
      String(activeResource?.fields?.[attachMatch.matchField] ?? "") ===
        String(resource.fields[attachMatch.matchField] ?? ""));
  const isDropTarget = secretDropOk || attachDropOk;
  const droppableId = attachDropOk
    ? `attach-target:${resource.id}`
    : `sidebar-resource:${resource.id}`;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: droppableId,
    disabled: !isDropTarget,
    ...(attachDropOk ? { data: { target: draggableData } } : {}),
  });

  const showDropHint = isOver && isDropTarget && !isDragging;
  const dropHintLabel = attachDropOk ? (attachMatch?.verb ?? "Attach") : "Drop";

  return (
    <div ref={setDropRef} className="inline-flex">
      <div
        ref={setDragRef}
        {...listeners}
        {...attributes}
        onClick={onOpen}
        onContextMenu={
          (sshHost || supportsMetrics) && onContextMenuOpen
            ? (e) => onContextMenuOpen(e, sshHost)
            : undefined
        }
        className={`group flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full border transition-colors cursor-grab active:cursor-grabbing ${
          showDropHint
            ? "border-blue-500 bg-accent-muted"
            : "border-border-strong bg-surface-raised hover:border-border-strong"
        } ${isDragging ? "opacity-40" : ""}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-on-surface-secondary leading-none">
            {resource.displayName}
          </span>
          {subtitle && (
            <span className="text-xs text-on-surface-muted leading-none">{subtitle}</span>
          )}
        </div>

        {showDropHint ? (
          <span className="ml-1 text-xs text-accent">{dropHintLabel}</span>
        ) : (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPin();
              }}
              title={pinned ? "Unpin" : "Pin to dashboard"}
              className={`ml-1 p-1 rounded-full text-xs transition-all ${
                pinned
                  ? "text-accent hover:text-accent-on-muted"
                  : "text-on-surface-faint hover:text-on-surface-tertiary opacity-0 group-hover:opacity-100"
              }`}
            >
              📌
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              title="Open detail view"
              className="p-1 rounded-full text-on-surface-faint hover:text-on-surface-secondary opacity-0 group-hover:opacity-100 transition-all text-xs"
            >
              →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
