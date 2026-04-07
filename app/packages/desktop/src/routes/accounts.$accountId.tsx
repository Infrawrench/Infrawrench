import { useState, useEffect, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { invoke } from "../lib/invoke";
import { useDraggable } from "@dnd-kit/core";
import type { ResourceInstance, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { useUIStore } from "@infrawrench/ui";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { pinResource, type DraggableResource } from "../lib/pins";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { CreateResourceModal } from "../components/CreateResourceModal";
import { navigateToWorkspaceTarget, resourceTabTarget } from "../lib/workspace-tabs";

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

interface ResourceGroup {
  typeDef: ResourceTypeDefinition;
  resources: ResourceInstance[];
}

function AccountPage() {
  const { accountId } = Route.useParams();
  const navigate = useNavigate();
  const bumpAccounts = useUIStore((s) => s.bumpAccounts);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const [account, setAccount] = useState<AccountRow | null>(null);
  const [groups, setGroups] = useState<ResourceGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createTarget, setCreateTarget] = useState<ResourceTypeDefinition | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const backgroundLoadRef = useRef(false);

  // Re-fetch when a resource is deleted (or otherwise changed) for this account
  useEffect(() => {
    function handler(e: Event) {
      const { accountId: changedId } = (e as CustomEvent<{ accountId: string }>).detail;
      if (changedId === accountId) { backgroundLoadRef.current = true; setLoadVersion((v) => v + 1); }
    }
    window.addEventListener("iw:resources-changed", handler);
    return () => window.removeEventListener("iw:resources-changed", handler);
  }, [accountId]);

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
      if (!isBackground) { setLoading(true); setError(null); }
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
        const topLevelTypes = plugin.resourceTypes.filter((t) => !t.parentTypeId);

        const results = await Promise.allSettled(
          topLevelTypes.map(async (t) => ({
            typeDef: t,
            resources: await client.listResources(t.id, accountId),
          })),
        );

        const resolved: ResourceGroup[] = [];
        for (const r of results) {
          if (r.status === "fulfilled") resolved.push(r.value);
        }
        if (!cancelled) setGroups(resolved);

        // Which resources are already pinned?
        const pins = await db.select<{ resource_id: string }[]>(
          "SELECT resource_id FROM dashboard_pins",
        );
        if (!cancelled) setPinned(new Set(pins.map((p) => p.resource_id)));
      } catch (e) {
        if (!cancelled && !isBackground) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
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

  if (loading) {
    return <div className="flex items-center justify-center h-full text-gray-600 text-sm">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-red-400 text-sm">{error}</div>;
  }

  return (
    <div className="p-6 overflow-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">{account?.display_name}</h1>
          <p className="text-xs text-gray-500 mt-0.5">{account?.plugin_id}</p>
        </div>
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Remove this account?</span>
            <button
              onClick={() => void deleteAccount()}
              className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
            >
              Remove
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
          >
            Remove account
          </button>
        )}
      </div>

      {groups.map((group) =>
        group.resources.length === 0 && !group.typeDef.supportsCreate ? null : (
          <div key={group.typeDef.id} className="mb-8">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {group.typeDef.pluralDisplayName}
            </h2>
            <div className="flex flex-wrap gap-2">
              {group.resources.map((resource) => (
                <ResourcePill
                  key={resource.id}
                  resource={resource}
                  typeId={group.typeDef.id}
                  pinned={pinned.has(resource.id)}
                  onPin={() => togglePin(resource, group.typeDef.id)}
                  onOpen={() => openDetail(resource)}
                />
              ))}
              {group.typeDef.supportsCreate && (
                <button
                  onClick={() => setCreateTarget(group.typeDef)}
                  className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-gray-700 text-gray-600 hover:border-blue-600 hover:text-blue-400 transition-colors text-sm"
                >
                  <span className="text-base leading-none">+</span>
                  <span>Create {group.typeDef.displayName}</span>
                </button>
              )}
            </div>
          </div>
        ),
      )}

      {groups.every((g) => g.resources.length === 0 && !g.typeDef.supportsCreate) && (
        <p className="text-sm text-gray-600">No resources found.</p>
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
    </div>
  );
}

function ResourcePill({
  resource,
  typeId,
  pinned,
  onPin,
  onOpen,
}: {
  resource: ResourceInstance;
  typeId: string;
  pinned: boolean;
  onPin: () => void;
  onOpen: () => void;
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

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: resource.id,
    data: { resource: draggableData },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`group flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full border border-gray-700 bg-gray-900 hover:border-gray-600 transition-colors cursor-grab active:cursor-grabbing ${isDragging ? "opacity-40" : ""}`}
    >
      <div onClick={onOpen} className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-gray-200 leading-none">{resource.displayName}</span>
        {subtitle && <span className="text-xs text-gray-500 leading-none">{subtitle}</span>}
      </div>

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
    </div>
  );
}
