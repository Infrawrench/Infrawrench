import { useState, useEffect, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { invoke } from "../lib/invoke";
import type { ResourceInstance, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import {
  useUIStore,
  useTabId,
  ConfirmDeleteModal,
  EditCredentialsModal,
  RESOURCES_CHANGED_EVENT,
  dispatchResourcesChanged,
  dispatchRefreshResource,
  AccountResourceSections,
  type SectionCategoryState,
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
  renameCloudAccount,
  updateCloudAccountCredentials,
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
import { ResourcePill } from "./_account-detail/-ResourcePill";

export const Route = createFileRoute("/accounts/$accountId")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches.
  component: () => null,
});

type CategoryState = SectionCategoryState<ResourceTypeDefinition, ResourceInstance>;

interface AccountPanelProps {
  accountId: string;
}

export function AccountPanel({ accountId }: AccountPanelProps) {
  const tabId = useTabId();
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
  const [editCredsState, setEditCredsState] = useState<{
    plugin: import("@infrawrench/ui").PluginInfo;
    current: Record<string, string>;
  } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account?.display_name ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const backgroundLoadRef = useRef(false);
  const [kubeconfigTypeIds, setKubeconfigTypeIds] = useState<Set<string>>(new Set());
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  // Read inside the load loop without retriggering it: changing the active
  // section after the initial fetch is in flight shouldn't restart everything.
  const activeSectionIdRef = useRef<string | null>(null);
  activeSectionIdRef.current = activeSectionId;
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
  const renameInputRef = useRef<HTMLInputElement>(null);
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
    if (account) setEditName(account.display_name);
  }, [account]);

  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
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
          const ownerCreds = await invoke<Record<string, string>>("account_get_credentials", {
            accountId: account.id,
          });
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

  // Move focus to the rename input when entering edit mode (intentional focus management).
  useEffect(() => {
    if (isEditing) renameInputRef.current?.focus();
  }, [isEditing]);

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
            if (tabId)
              useUIStore.getState().setWorkspaceTabTitle(tabId, detail.account.displayName);
          }

          // Local plugin gives us the full ResourceTypeDefinitions; the cloud
          // detail only returns ids and labels.
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

          // Single DB read — the poller keeps it fresh.
          listCloudAccountResources(orgId, accountId)
            .then((rows) => {
              if (cancelled) return;
              const byType = new Map<string, ResourceInstance[]>();
              for (const r of rows) {
                const fields = (r.fieldsJson ?? {}) as Record<string, string | number | boolean>;
                const outputs = (r.outputsJson ?? {}) as Record<string, string>;
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

          // No "pins by account" endpoint server-side; togglePin updates optimistically.
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
          if (tabId) useUIStore.getState().setWorkspaceTabTitle(tabId, row.display_name);
        }

        const credentials = await invoke<Record<string, string>>("account_get_credentials", {
          accountId: row.id,
        });

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

        // Dispatch the user's highlighted section first so its request gets
        // the first browser connection slot / token bucket allowance. Other
        // types still fire in parallel but a microsecond behind, which is
        // enough for the active section to win contention on slow providers.
        const priorityId = activeSectionIdRef.current;
        const orderedTypes = priorityId
          ? [
              ...allTypes.filter((t) => t.id === priorityId),
              ...allTypes.filter((t) => t.id !== priorityId),
            ]
          : allTypes;

        for (const typeDef of orderedTypes) {
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
                // Keep stale data, just clear the loading flag.
                setCategories((prev) =>
                  prev.map((cat) =>
                    cat.typeDef.id === typeDef.id ? { ...cat, loading: false } : cat,
                  ),
                );
              } else {
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
      try {
        if (pinned.has(resource.id)) {
          // Unpin from all dashboards in this org (best-effort per-dashboard).
          const dashboards = await listCloudDashboards(activeCloudOrgId);
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
          const dashboards = await listCloudDashboards(activeCloudOrgId);
          let home = dashboards.find((d) => d.isDefault);
          if (!home) {
            const created = await createCloudDashboard(activeCloudOrgId, "Home");
            if (!created) throw new Error("Failed to create Home dashboard");
            home = { ...created, isDefault: true };
          }
          await pinCloudResource(activeCloudOrgId, home.id, resource.id);
          setPinned((prev) => new Set(prev).add(resource.id));
        }
      } catch (err) {
        toast.error(`Couldn't update pin: ${formatErrorMessage(err)}`);
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
      // Satisfy the dashboard_pins FK by upserting the resource first.
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
      // Cascades to resources, dashboard_pins, secret_field_states, ssh_tunnel_configs via FK.
      await db.execute("DELETE FROM accounts WHERE id = $1", [accountId]);
    }
    removeWorkspaceTabs(
      useUIStore
        .getState()
        .workspaceTabs.flatMap((tab) =>
          (tab.target.kind === "account" && tab.target.accountId === accountId) ||
          (tab.target.kind === "resource" && tab.target.accountId === accountId)
            ? [tab.id]
            : [],
        ),
    );
    bumpAccounts();
    navigate({ to: "/" });
  }

  async function handleRename() {
    if (!editName.trim() || editName === account?.display_name) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      if (activeCloudOrgId) {
        const result = await renameCloudAccount(activeCloudOrgId, accountId, editName.trim());
        setAccount((prev) => (prev ? { ...prev, display_name: result.displayName } : prev));
      } else {
        const db = await getDb();
        await db.execute("UPDATE accounts SET display_name = $1 WHERE id = $2", [
          editName.trim(),
          accountId,
        ]);
        setAccount((prev) => (prev ? { ...prev, display_name: editName.trim() } : prev));
      }
      if (tabId) useUIStore.getState().setWorkspaceTabTitle(tabId, editName.trim());
      bumpAccounts();
      setIsEditing(false);
    } catch (e) {
      toast.error(`Couldn't rename account: ${formatErrorMessage(e)}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function openEditCredentials() {
    if (!account) return;
    try {
      const loaded = await getPlugin(account.plugin_id);
      if (!loaded) throw new Error(`Plugin "${account.plugin_id}" not loaded`);
      const manifest = loaded.plugin.manifest;
      const current = activeCloudOrgId
        ? await invoke<Record<string, string>>("cloud_get_account_credentials", {
            orgId: activeCloudOrgId,
            accountId,
          }).catch(() => ({}) as Record<string, string>)
        : await invoke<Record<string, string>>("account_get_credentials", { accountId });
      setEditCredsState({
        plugin: {
          id: manifest.id,
          displayName: manifest.displayName,
          logoSvg: manifest.logoSvg,
          credentialFields: manifest.credentialFields.map((f) => ({
            key: f.key,
            label: f.label,
            ...(f.description !== undefined ? { description: f.description } : {}),
            ...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {}),
            ...(f.sensitive !== undefined ? { sensitive: f.sensitive } : {}),
            ...(f.multiline !== undefined ? { multiline: f.multiline } : {}),
            ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
            ...(f.optional !== undefined ? { optional: f.optional } : {}),
            ...(f.regions !== undefined ? { regions: f.regions } : {}),
            ...(f.accountReference !== undefined ? { accountReference: f.accountReference } : {}),
            ...(f.helpLink !== undefined ? { helpLink: f.helpLink } : {}),
          })),
        },
        current,
      });
    } catch (err) {
      toast.error(`Couldn't open credentials: ${formatErrorMessage(err)}`);
    }
  }

  async function saveCredentials(credentials: Record<string, string>) {
    if (activeCloudOrgId) {
      await updateCloudAccountCredentials(activeCloudOrgId, accountId, credentials);
    } else {
      await invoke<void>("account_save_credentials", { accountId, credentials });
    }
    toast.success("Credentials updated");
    backgroundLoadRef.current = true;
    setLoadVersion((v) => v + 1);
    // Resource detail tabs and the sidebar bind credentials at mount-time, so
    // a save here doesn't auto-propagate. Force open tabs to re-fetch and
    // rebuild their plugin clients with the new credentials — otherwise the
    // user's next click into a peer pane still uses the old (broken) token.
    dispatchRefreshResource();
    dispatchResourcesChanged({ accountId });
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
      <div className="mb-6 flex items-start justify-between gap-2">
        <div>
          {isEditing ? (
            <div className="flex items-center gap-2">
              <input
                ref={renameInputRef}
                type="text"
                value={editName}
                aria-label="Account name"
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename();
                  if (e.key === "Escape") {
                    setEditName(account?.display_name ?? "");
                    setIsEditing(false);
                  }
                }}
                className="px-2 py-1 text-lg font-semibold bg-transparent border border-border rounded focus:outline-none focus:border-accent"
                disabled={isSaving}
              />
              <button
                type="button"
                onClick={handleRename}
                disabled={isSaving}
                className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditName(account?.display_name ?? "");
                  setIsEditing(false);
                }}
                disabled={isSaving}
                className="px-2 py-1 text-xs text-on-surface-muted hover:text-on-surface hover:bg-surface-overlay rounded"
              >
                Cancel
              </button>
            </div>
          ) : (
            <h1 className="text-lg font-semibold text-on-surface">{account?.display_name}</h1>
          )}
          <p className="text-xs text-on-surface-muted mt-0.5">{account?.plugin_id}</p>
        </div>
        <div className="flex items-center gap-1">
          {!isEditing && (
            <>
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="text-xs text-on-surface-faint hover:text-on-surface transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => void openEditCredentials()}
                className="text-xs text-on-surface-faint hover:text-on-surface transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
              >
                Update credentials
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-on-surface-faint hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
          >
            Remove
          </button>
        </div>
      </div>

      <AccountResourceSections
        categories={categories}
        activeSectionId={activeSectionId}
        onActiveSectionIdChange={setActiveSectionId}
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
            type="button"
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
          role="menu"
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 50 }}
          className="bg-surface-overlay border border-border-strong rounded-lg shadow-xl py-1 min-w-[200px]"
        >
          {contextMenu.sshHost && (
            <button
              type="button"
              role="menuitem"
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
              type="button"
              role="menuitem"
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
              type="button"
              role="menuitem"
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

      {editCredsState && account && (
        <EditCredentialsModal
          plugin={editCredsState.plugin}
          accountDisplayName={account.display_name}
          currentCredentials={editCredsState.current}
          onSave={saveCredentials}
          onClose={() => setEditCredsState(null)}
          onOpenExternal={(url) => void invoke("open_external_url", { url })}
        />
      )}
    </div>
  );
}
