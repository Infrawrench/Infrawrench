import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SpotlightSearch } from "./SpotlightSearch";
import { invoke } from "../lib/invoke";
import { useDroppable } from "@dnd-kit/core";
import { useUIStore, getListableResourceTypes, extractHostLabel } from "@infrawrench/ui";
import { getDb } from "../db/client";
import { loadPlugins, getPlugin } from "../plugins/loader";
import { formatErrorMessage } from "../lib/errors";
import { buildHostServices, buildKvHostServices, buildMemcachedHostServices, buildDockerHostServices } from "../lib/sql-drivers";
import { resolveTunneledHost } from "../lib/ssh-tunnel";
import { getSqlSession, setSqlSession } from "../lib/sql-session";
import { accountTabTarget, navigateToWorkspaceTarget, resourceTabTarget } from "../lib/workspace-tabs";
import type { SearchResult } from "./SpotlightSearch";

interface PinnedRow {
  resource_id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
  fields_json: string;
  outputs_json: string;
}

interface PluginMeta {
  logoSvg: string;
  displayName: string;
  sqlDriverName?: string | undefined;
  sqlCredentialKey?: string | undefined;
  kvDriverName?: string | undefined;
  kvCredentialKey?: string | undefined;
  dockerDriverName?: string | undefined;
  dockerCredentialKey?: string | undefined;
  tableCountLabel: string;
  storageResourceTypeIds: string[];
  terminalResourceTypeIds: string[];
}

interface CardStatus {
  phase: "connecting" | "ok" | "error";
  // resource stats
  pgVersion?: string | undefined;
  dbSize?: string | undefined;
  tableCount?: number | undefined;
  tableCountLabel?: string | undefined;
  // account summary stats
  resourceCounts?: { typeLabel: string; count: number }[] | undefined;
  error?: string | undefined;
  // SSH connect button
  sshTarget?: boolean;
  resourceId?: string;
  accountId?: string;
}

interface DashboardViewProps {
  dashboardId: string;
}


export function DashboardView({ dashboardId }: DashboardViewProps) {
  const navigate = useNavigate();
  const [pinned, setPinned] = useState<PinnedRow[]>([]);
  const [pluginMeta, setPluginMeta] = useState<Record<string, PluginMeta>>({});
  const [loading, setLoading] = useState(true);
  const [dashboardName, setDashboardName] = useState("");
  const [isHome, setIsHome] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [cardStatus, setCardStatus] = useState<Record<string, CardStatus>>({});

  const [spotlightMode, setSpotlightMode] = useState<"pin" | "navigate" | null>(null);
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);
  const bumpDashboardPins = useUIStore((s) => s.bumpDashboardPins);
  const setAccountConnected = useUIStore((s) => s.setAccountConnected);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const { setNodeRef, isOver } = useDroppable({ id: `dashboard:${dashboardId}` });

  const load = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const [db, plugins] = await Promise.all([getDb(), loadPlugins()]);
      const meta: Record<string, PluginMeta> = {};
      for (const p of plugins) {
        const m = p.plugin.manifest;
        meta[m.id] = {
          logoSvg: m.logoSvg,
          displayName: m.displayName,
          sqlDriverName: m.sqlDriver?.driver,
          sqlCredentialKey: m.sqlDriver?.credentialKey,
          kvDriverName: m.kvDriver?.driver,
          kvCredentialKey: m.kvDriver?.credentialKey,
          dockerDriverName: m.dockerDriver?.driver,
          dockerCredentialKey: m.dockerDriver?.credentialKey,
          tableCountLabel: m.dockerDriver ? "Running" : m.kvDriver?.driver === "mongodb" ? "Collections" : "Tables",
          storageResourceTypeIds: p.plugin.resourceTypes
            .filter((t) => t.supportsStorageBrowser)
            .map((t) => t.id),
          terminalResourceTypeIds: p.plugin.resourceTypes
            .filter((t) => t.supportsTerminal)
            .map((t) => t.id),
        };
      }
      setPluginMeta(meta);

      const nameRows = await db.select<{ name: string; is_default: number }[]>(
        "SELECT name, is_default FROM dashboards WHERE id = $1 LIMIT 1",
        [dashboardId],
      );
      if (!nameRows[0]) {
        setNotFound(true);
        return;
      }
      const loadedName = nameRows[0].name;
      setDashboardName(loadedName);
      setIsHome(nameRows[0].is_default === 1);

      // Update tab title with actual dashboard name
      const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
      if (activeWorkspaceTabId) setWorkspaceTabTitle(activeWorkspaceTabId, loadedName);

      const rows = await db.select<PinnedRow[]>(`
        SELECT r.id as resource_id, r.plugin_id, r.resource_type_id,
               r.account_id, r.display_name, r.fields_json, r.outputs_json
        FROM dashboard_pins dp
        JOIN resources r ON r.id = dp.resource_id
        WHERE dp.dashboard_id = $1
        ORDER BY dp.created_at DESC
        LIMIT 50
      `, [dashboardId]);

      // Restore "ok" status from cache for cards that are already connected,
      // so re-loads (e.g. after pinning a new resource) don't flash "Connecting…"
      setCardStatus((prev) => {
        const next: Record<string, CardStatus> = {};
        for (const row of rows) {
          if (prev[row.resource_id]?.phase === "ok") {
            // Keep the existing connected status
            next[row.resource_id] = prev[row.resource_id]!;
          } else if (row.resource_type_id !== "__account__" && getSqlSession(row.account_id)) {
            // Session alive — restore from cached outputs_json
            try {
              const o = JSON.parse(row.outputs_json) as { pgVersion?: string; dbSize?: string; tableCount?: number };
              if (o.pgVersion || o.tableCount != null) {
                next[row.resource_id] = { phase: "ok", pgVersion: o.pgVersion, dbSize: o.dbSize, tableCount: o.tableCount };
              }
            } catch { /* will connect fresh */ }
          }
        }
        return next;
      });

      setPinned(rows);
    } catch {
      // empty dashboard is fine
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  useEffect(() => {
    void load();
  }, [load, dashboardPinsVersion]);

  // ⌘K to open spotlight in navigate mode
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSpotlightMode("navigate");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Auto-connect cards after pins load
  useEffect(() => {
    if (pinned.length === 0) return;
    let cancelled = false;

    async function connectAll() {
      // Decrypt credentials once per unique account
      const credsByAccount = new Map<string, Record<string, string>>();
      const db = await getDb();

      const accountIds = [...new Set(pinned.map((r) => r.account_id))];
      await Promise.all(accountIds.map(async (accountId) => {
        try {
          const rows = await db.select<{ encrypted_credentials: string; credentials_iv: string }[]>(
            "SELECT encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
            [accountId],
          );
          if (!rows[0]) return;
          const plaintext = await invoke<string>("decrypt_value", {
            ciphertext: rows[0].encrypted_credentials,
            iv: rows[0].credentials_iv,
          });
          credsByAccount.set(accountId, JSON.parse(plaintext) as Record<string, string>);
        } catch { /* skip this account */ }
      }));

      // Mark cards as "connecting" — but only those not already connected
      const connectableIds = pinned
        .filter((r) => {
          const m = pluginMeta[r.plugin_id];
          return credsByAccount.has(r.account_id) &&
            (r.resource_type_id === "__account__" ||
              (!!m?.sqlDriverName && !!m.sqlCredentialKey) ||
              (!!m?.kvDriverName && !!m.kvCredentialKey) ||
              (!!m?.dockerDriverName && !!m.dockerCredentialKey) ||
              (m?.storageResourceTypeIds.includes(r.resource_type_id) ?? false) ||
              (m?.terminalResourceTypeIds.includes(r.resource_type_id) ?? false));
        })
        .map((r) => r.resource_id);

      if (connectableIds.length === 0) return;

      if (!cancelled) {
        setCardStatus((prev) => {
          const next = { ...prev };
          for (const id of connectableIds) {
            if (prev[id]?.phase !== "ok") next[id] = { phase: "connecting" };
          }
          return next;
        });
      }

      // Connect each card in parallel — skip cards already showing "ok"
      await Promise.all(pinned.map(async (row) => {
        const creds = credsByAccount.get(row.account_id);
        if (!creds) return;
        // Read current status via functional pattern below; skip if already connected
        let alreadyOk = false;
        setCardStatus((prev) => { alreadyOk = prev[row.resource_id]?.phase === "ok"; return prev; });
        if (alreadyOk) return;

        // ── Account summary card ─────────────────────────────────────────
        if (row.resource_type_id === "__account__") {
          try {
            const loaded = await getPlugin(row.plugin_id);
            if (!loaded) throw new Error(`Plugin not found: ${row.plugin_id}`);
            const sqlDecl = loaded.plugin.manifest.sqlDriver;
            const hostServices = sqlDecl
              ? buildHostServices(sqlDecl.driver, creds[sqlDecl.credentialKey] ?? "")
              : undefined;
            const client = loaded.plugin.createClient(creds, hostServices);
            const topLevelTypes = getListableResourceTypes(loaded.plugin.resourceTypes);
            const results = await Promise.allSettled(
              topLevelTypes.map(async (t) => ({
                typeLabel: t.pluralDisplayName,
                count: (await client.listResources(t.id, row.account_id)).length,
              })),
            );
            const resourceCounts = results
              .filter((r) => r.status === "fulfilled" && r.value.count > 0)
              .map((r) => (r as PromiseFulfilledResult<{ typeLabel: string; count: number }>).value);

            if (!cancelled) {
              setAccountConnected(row.account_id, true);
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: { phase: "ok", resourceCounts },
              }));
            }
          } catch (e) {
            if (!cancelled) {
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: { phase: "error", error: formatErrorMessage(e) },
              }));
            }
          }
          return;
        }

        // ── KV resource card (e.g. Redis) ─────────────────────────────────
        const meta = pluginMeta[row.plugin_id];
        if (meta?.kvDriverName && meta.kvCredentialKey) {
          const cs = creds[meta.kvCredentialKey];
          if (!cs) return;
          const hostServices = meta.kvDriverName === "memcached"
            ? buildMemcachedHostServices(meta.kvDriverName!, cs)
            : buildKvHostServices(meta.kvDriverName!, cs);
          try {
            const loaded = await getPlugin(row.plugin_id);
            if (!loaded) throw new Error(`Plugin not found: ${row.plugin_id}`);
            const client = loaded.plugin.createClient(creds, hostServices);
            const stats = await client.fetchStats?.();
            const { version = "", size = "" } = stats ?? {};

            try {
              await db.execute(
                "UPDATE resources SET outputs_json = $1 WHERE id = $2",
                [JSON.stringify({ pgVersion: version, dbSize: size }), row.resource_id],
              );
            } catch { /* not critical */ }

            if (!cancelled) {
              setAccountConnected(row.account_id, true);
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: { phase: "ok", pgVersion: version, dbSize: size },
              }));
            }
          } catch (e) {
            if (!cancelled) {
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: { phase: "error", error: formatErrorMessage(e) },
              }));
            }
          }
          return;
        }

        // ── Docker resource card ──────────────────────────────────────────
        if (meta?.dockerDriverName && meta.dockerCredentialKey) {
          const rawDockerHost = creds[meta.dockerCredentialKey] ?? "";
          try {
            const effectiveDockerHost = await resolveTunneledHost(row.account_id, rawDockerHost);
            const hostServices = buildDockerHostServices(meta.dockerDriverName, effectiveDockerHost);
            const loaded = await getPlugin(row.plugin_id);
            if (!loaded) throw new Error(`Plugin not found: ${row.plugin_id}`);
            const client = loaded.plugin.createClient(creds, hostServices);
            const stats = await client.fetchStats?.();
            const { version = "", size = "", tableCount = 0 } = stats ?? {};

            if (!cancelled) {
              setAccountConnected(row.account_id, true);
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: { phase: "ok", pgVersion: version, dbSize: size, tableCount, tableCountLabel: "Running" },
              }));
            }
          } catch (e) {
            if (!cancelled) {
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: { phase: "error", error: formatErrorMessage(e) },
              }));
            }
          }
          return;
        }

        // ── SSH terminal card ─────────────────────────────────────────────
        if (meta?.terminalResourceTypeIds.includes(row.resource_type_id)) {
          const host = String(creds["host"] ?? "");
          const port = String(creds["port"] ?? "22");
          if (!cancelled) {
            setAccountConnected(row.account_id, true);
            setCardStatus((prev) => ({
              ...prev,
              [row.resource_id]: {
                phase: "ok",
                pgVersion: `${host}:${port}`,
                sshTarget: true,
                resourceId: row.resource_id,
                accountId: row.account_id,
              },
            }));
          }
          return;
        }

        // ── Storage resource card (e.g. GCS bucket) ──────────────────────
        if (meta?.storageResourceTypeIds.includes(row.resource_type_id)) {
          try {
            const loaded = await getPlugin(row.plugin_id);
            if (!loaded) throw new Error(`Plugin not found: ${row.plugin_id}`);
            const client = loaded.plugin.createClient(creds);
            // bucket name is the last segment of the resource_id (accountId:typeId:bucketName)
            const bucketName = row.resource_id.split(":").slice(2).join(":");
            const stats = await (client as { fetchStorageStats?(b: string): Promise<{ count: number; size: string }> })
              .fetchStorageStats?.(bucketName);
            if (!cancelled) {
              setAccountConnected(row.account_id, true);
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: {
                  phase: "ok",
                  tableCount: stats?.count,
                  tableCountLabel: "Objects",
                  dbSize: stats?.size,
                },
              }));
            }
          } catch (e) {
            if (!cancelled) {
              setCardStatus((prev) => ({
                ...prev,
                [row.resource_id]: { phase: "error", error: formatErrorMessage(e) },
              }));
            }
          }
          return;
        }

        // ── SQL resource card (any plugin with sqlDriver declared) ────────
        if (!meta?.sqlDriverName || !meta.sqlCredentialKey) return;
        const cs = creds[meta.sqlCredentialKey];
        if (!cs) return;
        const hostServices = buildHostServices(meta.sqlDriverName!, cs);

        try {
          const loaded = await getPlugin(row.plugin_id);
          if (!loaded) throw new Error(`Plugin not found: ${row.plugin_id}`);
          const client = loaded.plugin.createClient(creds, hostServices);
          const stats = await client.fetchStats?.();
          const { version = "", size = "", tableCount = 0 } = stats ?? {};
          // Cache the connection string immediately so the detail page can fast-path
          setSqlSession(row.account_id, { connectionString: cs });

          // Introspect in background and update the cache once done
          void client.introspect?.().then((tables) => {
            if (tables && tables.length > 0) {
              setSqlSession(row.account_id, { connectionString: cs, tablesJson: JSON.stringify(tables) });
            }
          }).catch(() => undefined);

          try {
            await db.execute(
              "UPDATE resources SET outputs_json = $1 WHERE id = $2",
              [JSON.stringify({ pgVersion: version, dbSize: size, tableCount }), row.resource_id],
            );
          } catch { /* not critical */ }

          if (!cancelled) {
            setAccountConnected(row.account_id, true);
            setCardStatus((prev) => ({
              ...prev,
              [row.resource_id]: { phase: "ok", pgVersion: version, dbSize: size, tableCount },
            }));
          }
        } catch (e) {
          if (!cancelled) {
            setCardStatus((prev) => ({
              ...prev,
              [row.resource_id]: { phase: "error", error: formatErrorMessage(e) },
            }));
          }
        }
      }));
    }

    void connectAll();

    const interval = setInterval(() => { void connectAll(); }, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [pinned]);

  async function unpin(resourceId: string) {
    const db = await getDb();
    await db.execute(
      "DELETE FROM dashboard_pins WHERE resource_id = $1 AND dashboard_id = $2",
      [resourceId, dashboardId],
    );
    setPinned((prev) => prev.filter((r) => r.resource_id !== resourceId));
  }

  async function saveName(name: string) {
    const trimmed = name.trim() || "Dashboard";
    setDashboardName(trimmed);
    setEditingName(false);
    const db = await getDb();
    await db.execute("UPDATE dashboards SET name = $1 WHERE id = $2", [trimmed, dashboardId]);
    const tabsToRename = useUIStore.getState().workspaceTabs
      .filter((tab) => tab.target.kind === "dashboard" && tab.target.dashboardId === dashboardId)
      .map((tab) => tab.id);
    for (const tabId of tabsToRename) {
      useUIStore.getState().setWorkspaceTabTitle(tabId, trimmed);
    }
  }

  async function deleteDashboard() {
    if (isHome) return;
    const db = await getDb();
    await db.execute("DELETE FROM dashboard_pins WHERE dashboard_id = $1", [dashboardId]);
    await db.execute("DELETE FROM dashboards WHERE id = $1", [dashboardId]);
    removeWorkspaceTabs(
      useUIStore.getState().workspaceTabs
        .filter((tab) => tab.target.kind === "dashboard" && tab.target.dashboardId === dashboardId)
        .map((tab) => tab.id),
    );
    navigate({ to: "/" });
  }

  function goToResource(row: PinnedRow) {
    if (row.resource_type_id === "__account__") {
      void navigateToWorkspaceTarget(
        navigate,
        accountTabTarget(row.account_id),
        { label: row.display_name },
      );
    } else {
      void navigateToWorkspaceTarget(
        navigate,
        resourceTabTarget(row.account_id, row.resource_id),
        { label: row.display_name },
      );
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        Loading…
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        Dashboard not found.
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col h-full transition-colors ${isOver ? "bg-blue-950/20" : ""}`}
    >
      {/* Header */}
      <div className="px-8 pt-8 pb-4 border-b border-gray-800/50 flex items-center justify-between">
        <div>
          {editingName ? (
            <input
              autoFocus
              defaultValue={dashboardName}
              onBlur={(e) => void saveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName(e.currentTarget.value);
                if (e.key === "Escape") setEditingName(false);
              }}
              className="text-2xl font-semibold bg-transparent border-b border-blue-500 text-gray-100 focus:outline-none"
            />
          ) : (
            <h1
              className="text-2xl font-semibold text-gray-100 cursor-default hover:text-white"
              onDoubleClick={() => setEditingName(true)}
              title="Double-click to rename"
            >
              {dashboardName}
            </h1>
          )}
        </div>

        {!isHome && (
          <button
            onClick={() => void deleteDashboard()}
            title="Delete dashboard"
            className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
          >
            Delete
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 py-6">
        {pinned.length === 0 ? (
          <button
            onClick={() => setSpotlightMode("pin")}
            className={`w-full flex flex-col items-center justify-center h-64 rounded-2xl border-2 border-dashed transition-colors ${isOver ? "border-blue-500 text-blue-400" : "border-gray-800 text-gray-700 hover:border-gray-600 hover:text-gray-500"}`}
          >
            <span className="text-3xl mb-3">⊞</span>
            <p className="text-sm">Click to add a resource</p>
            <p className="text-xs mt-1 opacity-60">or drag one here</p>
          </button>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {pinned.map((row) => (
              <ResourceCard
                key={row.resource_id}
                row={row}
                pluginMeta={pluginMeta[row.plugin_id]}
                status={cardStatus[row.resource_id]}
                onOpen={() => goToResource(row)}
                onUnpin={() => void unpin(row.resource_id)}
                onConnect={cardStatus[row.resource_id]?.sshTarget ? () => goToResource(row) : undefined}
              />
            ))}

            <button
              onClick={() => setSpotlightMode("pin")}
              className={`rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-1.5 transition-colors min-h-[140px] ${isOver ? "border-blue-500 text-blue-400 bg-blue-500/5" : "border-gray-800 text-gray-700 hover:border-gray-600 hover:text-gray-500"}`}
            >
              <span className="text-2xl">+</span>
              <span className="text-xs">Add resource</span>
            </button>
          </div>
        )}

        {spotlightMode && (
          <SpotlightSearch
            dashboardId={dashboardId}
            mode={spotlightMode}
            onClose={() => setSpotlightMode(null)}
            onPinned={() => { bumpDashboardPins(); setSpotlightMode(null); }}
            onNavigate={(result) => {
              setSpotlightMode(null);
              void navigateToWorkspaceTarget(
                navigate,
                resourceTabTarget(result.accountId, result.id),
                { label: result.displayName },
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

function ResourceCard({
  row,
  pluginMeta,
  status,
  onOpen,
  onUnpin,
  onConnect,
}: {
  row: PinnedRow;
  pluginMeta?: PluginMeta | undefined;
  status?: CardStatus | undefined;
  onOpen: () => void;
  onUnpin: () => void;
  onConnect?: (() => void) | undefined;
}) {
  const fields = (() => {
    try { return JSON.parse(row.fields_json) as Record<string, unknown>; }
    catch { return {}; }
  })();

  const host = extractHostLabel(fields);

  return (
    <div className="group relative rounded-2xl border border-gray-800 bg-gray-900 hover:border-gray-700 transition-colors flex flex-col overflow-hidden">
      {/* Unpin button */}
      <button
        onClick={(e) => { e.stopPropagation(); onUnpin(); }}
        title="Remove from dashboard"
        className="absolute top-2 right-2 w-5 h-5 rounded-full text-gray-700 hover:text-gray-300 hover:bg-gray-700 transition-all opacity-0 group-hover:opacity-100 text-xs flex items-center justify-center"
      >
        ✕
      </button>

      <button onClick={onOpen} className="flex-1 flex flex-col p-5 text-left gap-3">
        {/* Plugin logo + name */}
        <div className="flex items-center gap-2">
          {pluginMeta?.logoSvg ? (
            <div
              className="w-6 h-6 flex-shrink-0"
              dangerouslySetInnerHTML={{ __html: pluginMeta.logoSvg }}
            />
          ) : (
            <span className="text-xs text-gray-600 font-mono">{row.plugin_id}</span>
          )}
          <span className="text-xs text-gray-500">{pluginMeta?.displayName ?? row.plugin_id}</span>
        </div>

        {/* Resource name */}
        <div>
          <p className="text-base font-semibold text-gray-100 leading-tight">{row.display_name}</p>
          {host && <p className="text-xs text-gray-500 mt-0.5 truncate">{host}</p>}
        </div>
      </button>

      {/* Connection status footer */}
      <ConnectionFooter status={status} onConnect={onConnect} />
    </div>
  );
}

function ConnectionFooter({ status, onConnect }: { status?: CardStatus | undefined; onConnect?: (() => void) | undefined }) {
  if (!status) return null;

  if (status.phase === "connecting") {
    return (
      <div className="px-5 py-3 border-t border-gray-800 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-pulse flex-shrink-0" />
        <span className="text-xs text-gray-600">Connecting…</span>
      </div>
    );
  }

  if (status.phase === "error") {
    return (
      <div className="px-5 py-3 border-t border-gray-800 flex items-center gap-2" title={status.error}>
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
        <span className="text-xs text-red-500 truncate">{status.error ?? "Connection failed"}</span>
      </div>
    );
  }

  // ok — show stats
  return (
    <div className="px-5 py-3 border-t border-gray-800 space-y-1">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
        <span className="text-xs text-gray-600">Connected</span>
      </div>
      {/* Postgres resource stats */}
      {status.pgVersion && (
        <div className="flex justify-between text-xs">
          <span className="text-gray-600">Version</span>
          <span className="text-gray-400">{status.pgVersion}</span>
        </div>
      )}
      {status.tableCount != null && (
        <div className="flex justify-between text-xs">
          <span className="text-gray-600">{status.tableCountLabel ?? "Tables"}</span>
          <span className="text-gray-400">{status.tableCount}</span>
        </div>
      )}
      {status.dbSize && (
        <div className="flex justify-between text-xs">
          <span className="text-gray-600">Size</span>
          <span className="text-gray-400">{status.dbSize}</span>
        </div>
      )}
      {/* Account summary stats */}
      {status.resourceCounts?.map(({ typeLabel, count }) => (
        <div key={typeLabel} className="flex justify-between text-xs">
          <span className="text-gray-600">{typeLabel}</span>
          <span className="text-gray-400">{count}</span>
        </div>
      ))}

      {/* SSH fast-connect button */}
      {status.sshTarget && onConnect && (
        <button
          onClick={(e) => { e.stopPropagation(); onConnect(); }}
          className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-950 border border-green-800 hover:bg-green-900 hover:border-green-700 text-green-400 hover:text-green-300 text-xs font-medium transition-colors"
        >
          <span>⌨</span>
          Connect
        </button>
      )}
    </div>
  );
}
