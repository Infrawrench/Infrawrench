import { useState, useEffect, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { invoke } from "../lib/invoke";
import { useDraggable, useDroppable, useDndContext } from "@dnd-kit/core";
import type { ResourceInstance, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { useUIStore, ConfirmDeleteModal, type DraggableResource } from "@infrawrench/ui";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { pinResource } from "../lib/pins";
import { getAccountResourceTypes, isCreateOnlyType, getListableResourceTypes } from "../lib/account-resource-types";
import { formatErrorMessage } from "../lib/errors";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { CreateResourceModal } from "../components/CreateResourceModal";
import { SecretExportModal } from "../components/SecretExportModal";
import { SshTunnelModal, type PresetKey } from "../components/SshTunnelModal";
import { DockerSetupModal } from "../components/DockerSetupModal";
import { SshEnvDeployModal } from "../components/SshEnvDeployModal";
import { navigateToWorkspaceTarget, resourceTabTarget, accountTabTarget } from "../lib/workspace-tabs";

export const Route = createFileRoute("/accounts/$accountId")({
  component: AccountPage,
});

interface AccountRow {
  id: string;
  plugin_id: string;
  display_name: string;
  encrypted_credentials: string;
  credentials_iv: string;
}

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
    x: number; y: number; sshHost: string;
  } | null>(null);
  const [tunnelTarget, setTunnelTarget] = useState<{ sshHost: string; defaultService?: PresetKey } | null>(null);
  const [dockerSetupTarget, setDockerSetupTarget] = useState<{ sshHost: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [secretExportDrop, setSecretExportDrop] = useState<{
    source: DraggableResource;
    targetPluginId: string;
    targetCredentials: Record<string, string>;
  } | null>(null);
  const [envDeployDrop, setEnvDeployDrop] = useState<{
    source: DraggableResource; sshHost: string;
  } | null>(null);

  // Re-fetch when a resource is deleted (or otherwise changed) for this account
  useEffect(() => {
    function handler(e: Event) {
      const { accountId: changedId } = (e as CustomEvent<{ accountId: string }>).detail;
      if (changedId === accountId) { backgroundLoadRef.current = true; setLoadVersion((v) => v + 1); }
    }
    window.addEventListener("iw:resources-changed", handler);
    return () => window.removeEventListener("iw:resources-changed", handler);
  }, [accountId]);

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

  // Handle secret drops onto resource pills on this page
  useEffect(() => {
    function handler(e: Event) {
      const { source, targetId, kind } = (e as CustomEvent<{
        source: DraggableResource; targetId: string; kind: string;
      }>).detail;
      if (kind !== "resource") return;
      // Find the target in our categories
      const targetResource = categories.flatMap((c) => c.resources).find((r) => r.id === targetId);
      if (!targetResource) return;

      // Check if dropped onto a VM with SSH endpoint
      const targetCategory = categories.find((c) => c.resources.some((r) => r.id === targetId));
      const sshHostKey = targetCategory?.typeDef.sshEndpoint?.hostOutputKey;
      if (sshHostKey && !kubeconfigTypeIds.has(targetResource.resourceTypeId)) {
        const sshHost = String(targetResource.resolvedOutputs?.[sshHostKey] ?? targetResource.fields[sshHostKey] ?? "");
        if (sshHost) {
          const TUNNEL_PLUGINS = new Set(["docker", "postgres", "mysql", "redis", "memcached"]);
          const sourcePlugin = source.pluginId === "__account__"
            ? String(source.fields["pluginId"] ?? "") : source.pluginId;
          if (TUNNEL_PLUGINS.has(sourcePlugin)) {
            const pluginToPreset: Record<string, PresetKey> = {
              docker: "docker", postgres: "postgres", mysql: "mysql",
              redis: "redis", memcached: "memcached",
            };
            setTunnelTarget({ sshHost, defaultService: pluginToPreset[sourcePlugin] });
          } else {
            setEnvDeployDrop({ source, sshHost });
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
        }
      })();
    }
    window.addEventListener("iw:sidebar-secret-drop", handler);
    return () => window.removeEventListener("iw:sidebar-secret-drop", handler);
  }, [categories, kubeconfigTypeIds, account]);

  // Auto-refresh every 30 s (background — no loading flash)
  useEffect(() => {
    const id = setInterval(() => { backgroundLoadRef.current = true; setLoadVersion((v) => v + 1); }, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isBackground = backgroundLoadRef.current;
    backgroundLoadRef.current = false;
    async function load() {
      if (!isBackground) { setInitialLoading(true); setError(null); }
      try {
        const db = await getDb();
        const rows = await db.select<AccountRow[]>(
          "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
          [accountId],
        );
        const row = rows[0];
        if (!row) throw new Error("Account not found");
        if (!cancelled) setAccount(row);

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
        const topLevelTypes = getAccountResourceTypes(plugin.resourceTypes);

        // Check which resource types have kubeconfig outputs (can accept secret drops)
        const kcTypes = new Set<string>();
        for (const rt of plugin.resourceTypes) {
          if (rt.outputs?.some((o) => o.key === "kubeconfig")) kcTypes.add(rt.id);
        }
        if (!cancelled) setKubeconfigTypeIds(kcTypes);

        // On foreground load, show category headers immediately with loading skeletons
        if (!isBackground && !cancelled) {
          setCategories(topLevelTypes.map((t) => ({
            typeDef: t,
            loading: true,
            error: null,
            resources: [],
          })));
          setInitialLoading(false);
        }

        // Fire off independent async loads per category — skip create-only types
        const listableTypes = getListableResourceTypes(plugin.resourceTypes);
        for (const typeDef of topLevelTypes) {
          if (!listableTypes.some((t) => t.id === typeDef.id)) {
            // Create-only child type — no resources to list, just mark as loaded
            setCategories((prev) => prev.map((cat) =>
              cat.typeDef.id === typeDef.id ? { ...cat, loading: false } : cat,
            ));
            continue;
          }
          client.listResources(typeDef.id, accountId).then((resources) => {
            if (cancelled) return;
            setCategories((prev) => prev.map((cat) =>
              cat.typeDef.id === typeDef.id
                ? { ...cat, loading: false, error: null, resources }
                : cat,
            ));
          }).catch((err) => {
            if (cancelled) return;
            if (isBackground) {
              // Background refresh: silently clear loading, keep stale data
              setCategories((prev) => prev.map((cat) =>
                cat.typeDef.id === typeDef.id
                  ? { ...cat, loading: false }
                  : cat,
              ));
            } else {
              // Foreground: show error, but keep the category visible if it supports create
              setCategories((prev) => prev.map((cat) =>
                cat.typeDef.id === typeDef.id
                  ? { ...cat, loading: false, error: formatErrorMessage(err) }
                  : cat,
              ));
            }
          });
        }

        // Which resources are already pinned?
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
    return () => { cancelled = true; };
  }, [accountId, loadVersion]);

  async function togglePin(resource: ResourceInstance, typeId: string) {
    const db = await getDb();
    if (pinned.has(resource.id)) {
      await db.execute("DELETE FROM dashboard_pins WHERE resource_id = $1", [resource.id]);
      await db.execute("DELETE FROM resources WHERE id = $1", [resource.id]);
      setPinned((prev) => { const s = new Set(prev); s.delete(resource.id); return s; });
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
        await db.execute(
          "INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 1)",
          [dashId, "Home"],
        );
      }

      await db.execute(
        "INSERT OR IGNORE INTO dashboard_pins (id, dashboard_id, resource_id) VALUES ($1, $2, $3)",
        [crypto.randomUUID(), dashId, resource.id],
      );
      setPinned((prev) => new Set(prev).add(resource.id));
    }
  }

  async function deleteAccount() {
    const db = await getDb();
    // Cascade deletes resources, dashboard_pins, secret_field_states, ssh_tunnel_configs via FK
    await db.execute("DELETE FROM accounts WHERE id = $1", [accountId]);
    removeWorkspaceTabs(
      useUIStore.getState().workspaceTabs
        .filter((tab) =>
          (tab.target.kind === "account" && tab.target.accountId === accountId) ||
          (tab.target.kind === "resource" && tab.target.accountId === accountId),
        )
        .map((tab) => tab.id),
    );
    bumpAccounts();
    navigate({ to: "/" });
  }

  function openDetail(resource: ResourceInstance) {
    void navigateToWorkspaceTarget(
      navigate,
      resourceTabTarget(accountId, resource.id),
      { label: resource.displayName },
    );
  }

  if (initialLoading) {
    return <div className="flex items-center justify-center h-full text-gray-600 text-sm">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-red-400 text-sm">{error}</div>;
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">{account?.display_name}</h1>
          <p className="text-xs text-gray-500 mt-0.5">{account?.plugin_id}</p>
        </div>
        <button
          onClick={() => setConfirmDelete(true)}
          className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
        >
          Remove account
        </button>
      </div>

      {categories.map((cat) => {
        const createOnly = isCreateOnlyType(cat.typeDef);
        // Hide categories that finished loading with no resources and no create support,
        // or that errored (e.g. API not enabled) with nothing useful to show
        if (!cat.loading && cat.resources.length === 0 && !cat.typeDef.supportsCreate) return null;
        // Create-only types (child types with supportsCreate) show only the create button
        if (createOnly && !cat.typeDef.supportsCreate) return null;

        return (
          <div key={cat.typeDef.id} className="mb-8">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {cat.typeDef.pluralDisplayName}
            </h2>

            {createOnly ? (
              /* Child type — only show create button, resources shown on parent detail page */
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setCreateTarget(cat.typeDef)}
                  className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-gray-700 text-gray-600 hover:border-blue-600 hover:text-blue-400 transition-colors text-sm"
                >
                  <span className="text-base leading-none">+</span>
                  <span>Create {cat.typeDef.displayName}</span>
                </button>
              </div>
            ) : cat.loading ? (
              /* Skeleton pills while this category is loading */
              <div className="flex flex-wrap gap-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-8 rounded-full bg-gray-800 animate-pulse" style={{ width: `${5 + i * 1.5}rem` }} />
                ))}
              </div>
            ) : cat.error ? (
              <div className="text-xs text-red-400">{cat.error}</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {cat.resources.map((resource) => (
                  <ResourcePill
                    key={resource.id}
                    resource={resource}
                    typeId={cat.typeDef.id}
                    pinned={pinned.has(resource.id)}
                    acceptsSecretImport={kubeconfigTypeIds.has(cat.typeDef.id)}
                    sshHostOutputKey={cat.typeDef.sshEndpoint?.hostOutputKey}
                    onPin={() => togglePin(resource, cat.typeDef.id)}
                    onOpen={() => openDetail(resource)}
                    onContextMenuSsh={(e, sshHost) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, sshHost });
                    }}
                  />
                ))}
                {cat.typeDef.supportsCreate && (
                  <button
                    onClick={() => setCreateTarget(cat.typeDef)}
                    className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-gray-700 text-gray-600 hover:border-blue-600 hover:text-blue-400 transition-colors text-sm"
                  >
                    <span className="text-base leading-none">+</span>
                    <span>Create {cat.typeDef.displayName}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {categories.length > 0 && categories.every((c) => !c.loading && c.resources.length === 0 && !c.typeDef.supportsCreate) && (
        <p className="text-sm text-gray-600">No resources found.</p>
      )}

      {envDeployDrop && (
        <SshEnvDeployModal
          source={envDeployDrop.source}
          sshHost={envDeployDrop.sshHost}
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
            setCreateTarget(null);
            window.dispatchEvent(new CustomEvent("iw:resources-changed", { detail: { accountId } }));
            void navigateToWorkspaceTarget(
              navigate,
              resourceTabTarget(accountId, resource.id),
              { label: resource.displayName },
            );
          }}
        />
      )}

      {/* SSH context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}
          className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[200px]"
        >
          <button
            className="w-full px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 text-left flex items-center gap-2"
            onClick={() => {
              setTunnelTarget({ sshHost: contextMenu.sshHost });
              setContextMenu(null);
            }}
          >
            <span>⇢</span>
            Connect to service via SSH…
          </button>
          <button
            className="w-full px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 text-left flex items-center gap-2"
            onClick={() => {
              setDockerSetupTarget({ sshHost: contextMenu.sshHost });
              setContextMenu(null);
            }}
          >
            <span>🐳</span>
            Setup Docker on VM…
          </button>
        </div>
      )}

      {tunnelTarget && (
        <SshTunnelModal
          sshHost={tunnelTarget.sshHost}
          sourceAccountId={accountId}
          defaultService={tunnelTarget.defaultService}
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
  pinned,
  acceptsSecretImport,
  sshHostOutputKey,
  onPin,
  onOpen,
  onContextMenuSsh,
}: {
  resource: ResourceInstance;
  typeId: string;
  pinned: boolean;
  acceptsSecretImport?: boolean;
  sshHostOutputKey?: string;
  onPin: () => void;
  onOpen: () => void;
  onContextMenuSsh?: (e: React.MouseEvent, sshHost: string) => void;
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
  };

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: resource.id,
    data: { resource: draggableData },
  });

  const sshHost = sshHostOutputKey
    ? String(resource.resolvedOutputs?.[sshHostOutputKey] ?? resource.fields[sshHostOutputKey] ?? "")
    : "";

  // Separate droppable from draggable — combining refs on the same node in a
  // flex-wrap layout causes @dnd-kit to lose rect measurements during drag.
  // Disable drop when the dragged resource is from the same account — it's
  // already in this cluster, so creating a secret is pointless.
  const { active } = useDndContext();
  const activeResource = active?.data.current?.resource as DraggableResource | undefined;
  const sameCluster = activeResource?.accountId === resource.accountId;
  const isDropTarget = (!!acceptsSecretImport || !!sshHost) && !sameCluster;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `sidebar-resource:${resource.id}`,
    disabled: !isDropTarget,
  });

  const showDropHint = isOver && isDropTarget && !isDragging;

  return (
      <div ref={setDropRef} className="inline-flex">
        <div
          ref={setDragRef}
          {...listeners}
          {...attributes}
          onContextMenu={sshHost && onContextMenuSsh
            ? (e) => onContextMenuSsh(e, sshHost)
            : undefined}
          className={`group flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full border transition-colors cursor-grab active:cursor-grabbing ${
            showDropHint
              ? "border-blue-500 bg-blue-500/20"
              : "border-gray-700 bg-gray-900 hover:border-gray-600"
          } ${isDragging ? "opacity-40" : ""}`}
        >
          <div onClick={onOpen} className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-gray-200 leading-none">{resource.displayName}</span>
            {subtitle && <span className="text-xs text-gray-500 leading-none">{subtitle}</span>}
          </div>

          {showDropHint ? (
            <span className="ml-1 text-xs text-blue-400">Drop</span>
          ) : (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onPin(); }}
                title={pinned ? "Unpin" : "Pin to dashboard"}
                className={`ml-1 p-1 rounded-full text-xs transition-all ${
                  pinned
                    ? "text-blue-400 hover:text-blue-300"
                    : "text-gray-700 hover:text-gray-400 opacity-0 group-hover:opacity-100"
                }`}
              >
                📌
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); onOpen(); }}
                title="Open detail view"
                className="p-1 rounded-full text-gray-700 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-all text-xs"
              >
                →
              </button>
            </>
          )}
        </div>
      </div>
  );
}
