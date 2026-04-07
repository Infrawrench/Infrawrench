import React, { useState, useEffect, useCallback, useRef } from "react";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { invoke } from "../lib/invoke";
import type { ResourceInstance, DetailViewSchema } from "@infrawrench/plugin-base";
import { DetailView, type QueryResult, useUIStore } from "@infrawrench/ui";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { getSqlSession, setSqlSession } from "../lib/sql-session";
import { sqlQuery, sqlExecute, buildHostServices, buildKvHostServices, kvCommand, buildDockerHostServices, buildPluginHostServices } from "../lib/sql-drivers";
import { resolveTunneledHost } from "../lib/ssh-tunnel";
import { DockerActionsPanel } from "../components/DockerActionsPanel";
import { MongoDocumentBrowser } from "../components/MongoDocumentBrowser";
import { GcsBrowserPanel } from "../components/GcsBrowserPanel";
import { SftpBrowserPanel } from "../components/SftpBrowserPanel";
import { SshTerminal } from "../components/SshTerminal";
import { SshQuickConnectPanel } from "../components/SshQuickConnectPanel";
import { PeerPaneView } from "../components/PeerPaneView";
import type { PluginClient, PeerPaneContext } from "@infrawrench/plugin-base";
import type { PeerPaneData } from "@infrawrench/ui";
import { accountTabTarget, navigateToWorkspaceTarget, resourceSshTabTarget, resourceSftpTabTarget } from "../lib/workspace-tabs";
import { formatErrorMessage } from "../lib/errors";

export const Route = createFileRoute("/resource/$accountId/$resourceId")({
  component: ResourceDetailPage,
});

interface AccountRow {
  id: string;
  plugin_id: string;
  display_name: string;
  encrypted_credentials: string;
  credentials_iv: string;
}

interface SqliteResourceRow {
  id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
  external_id: string;
  fields_json: string;
}

function ResourceDetailPage() {
  const { accountId, resourceId } = Route.useParams();
  const decodedResourceId = decodeURIComponent(resourceId);

  const [account, setAccount] = useState<AccountRow | null>(null);
  const [resource, setResource] = useState<ResourceInstance | null>(null);
  const [schema, setSchema] = useState<DetailViewSchema | null>(null);
  const [logoSvg, setLogoSvg] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pgConnected, setPgConnected] = useState(false);
  const [pgError, setPgError] = useState<string | null>(null);
  const [kvConnected, setKvConnected] = useState(false);
  const [isKvPlugin, setIsKvPlugin] = useState(false);
  const [kvDriverName, setKvDriverName] = useState<string | null>(null);
  const [isDockerPlugin, setIsDockerPlugin] = useState(false);
  const [dockerDriverName, setDockerDriverName] = useState<string | null>(null);
  const [dockerHostRef] = useState({ current: "" });

  const connectionStringRef = useRef("");
  const sqlDriverIdRef = useRef("");
  const clientRef = useRef<PluginClient | null>(null);
  const [hasStorageToken, setHasStorageToken] = useState(false);
  const [sshConfig, setSshConfig] = useState<{ host: string; port: number; username: string; privateKey: string } | null>(null);
  const [sshHost, setSshHost] = useState<string | null>(null);
  const [quickSshConnection, setQuickSshConnection] = useState<{ username: string; privateKey: string } | null>(null);
  const setAccountConnected = useUIStore((s) => s.setAccountConnected);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const locationHash = useRouterState({ select: (s) => s.location.hash });
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [resourceTypeLabel, setResourceTypeLabel] = useState<string>("Resource");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [peerPanes, setPeerPanes] = useState<PeerPaneData[]>([]);
  const backgroundRefreshRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const isBackground = backgroundRefreshRef.current;
    backgroundRefreshRef.current = false;

    async function load() {
      if (!isBackground) {
        setError(null);
        setPgError(null);
      }

      try {
        const db = await getDb();
        const session = getSqlSession(accountId);

        // ── Fast path ─────────────────────────────────────────────────────
        // If we have a cached connection + the resource is in SQLite, show
        // the page immediately without waiting for listResources or pg queries.
        if (session) {
          connectionStringRef.current = session.connectionString;
          // Driver name is resolved properly in the full load; pre-populate from manifest
          // once we have the plugin. For now set from loaded plugin below if fast-path exits early.

          const [accountRows, sqliteRows] = await Promise.all([
            db.select<AccountRow[]>(
              "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
              [accountId],
            ),
            db.select<SqliteResourceRow[]>(
              "SELECT id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json FROM resources WHERE id = $1",
              [decodedResourceId],
            ),
          ]);

          const accountRow = accountRows[0];
          const sqliteRes = sqliteRows[0];

          if (accountRow && sqliteRes) {
            const loaded = await getPlugin(accountRow.plugin_id);
            if (loaded && !cancelled) {
              const fastTypeDef = loaded.plugin.resourceTypes.find((t) => t.id === sqliteRes.resource_type_id);
              const now = new Date().toISOString();
              const immediateResource: ResourceInstance = {
                id: sqliteRes.id,
                pluginId: sqliteRes.plugin_id,
                resourceTypeId: sqliteRes.resource_type_id,
                accountId: sqliteRes.account_id,
                displayName: sqliteRes.display_name,
                externalId: sqliteRes.external_id,
                fields: (() => { try { return JSON.parse(sqliteRes.fields_json); } catch { return {}; } })(),
                resolvedOutputs: session.tablesJson ? { __tables__: session.tablesJson } : {},
                secretStates: [],
                createdAt: now,
                updatedAt: now,
              };
              const fastSqlDecl = loaded.plugin.manifest.sqlDriver;
              const fastKvDecl = loaded.plugin.manifest.kvDriver;
              const fastServices = fastSqlDecl
                ? buildHostServices(fastSqlDecl.driver, session.connectionString)
                : fastKvDecl
                  ? buildKvHostServices(fastKvDecl.driver, session.connectionString)
                  : undefined;
              const immediateSchema = loaded.plugin.createClient(
                { connectionString: session.connectionString },
                fastServices,
              ).renderDetail(immediateResource);
              setAccount(accountRow);
              setLogoSvg(loaded.plugin.manifest.logoSvg);
              setResource(immediateResource);
              setResourceTypeLabel(fastTypeDef?.displayName ?? "Resource");
              setSchema(immediateSchema);
              setPgConnected(!!session.tablesJson);
              setAccountConnected(accountId, true);
              setLoading(false); // ← show the page NOW
            }
          }
        } else if (!isBackground) {
          setLoading(true);
        }

        // ── Full load (runs in background if fast path already showed the page) ──
        const accountRows = await db.select<AccountRow[]>(
          "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
          [accountId],
        );
        const accountRow = accountRows[0];
        if (!accountRow) throw new Error("Account not found");
        if (!cancelled) setAccount(accountRow);

        const plaintext = await invoke<string>("decrypt_value", {
          ciphertext: accountRow.encrypted_credentials,
          iv: accountRow.credentials_iv,
        });
        const credentials = JSON.parse(plaintext) as Record<string, string>;

        const loaded = await getPlugin(accountRow.plugin_id);
        if (!loaded) throw new Error(`Plugin "${accountRow.plugin_id}" not loaded`);
        const { plugin } = loaded;
        if (!cancelled) setLogoSvg(plugin.manifest.logoSvg);

        const sqlDriverDecl = loaded.plugin.manifest.sqlDriver;
        const kvDriverDecl = loaded.plugin.manifest.kvDriver;
        const dockerDriverDecl = loaded.plugin.manifest.dockerDriver;
        const isKv = !sqlDriverDecl && !!kvDriverDecl;
        const isDocker = !sqlDriverDecl && !kvDriverDecl && !!dockerDriverDecl;
        if (!cancelled) {
          setIsKvPlugin(isKv);
          setKvDriverName(kvDriverDecl?.driver ?? null);
          setIsDockerPlugin(isDocker);
          setDockerDriverName(dockerDriverDecl?.driver ?? null);
          if (kvDriverDecl?.driver === "mongodb") setDetailsCollapsed(true);
        }
        const cs = sqlDriverDecl
          ? credentials[sqlDriverDecl.credentialKey]
          : kvDriverDecl
            ? credentials[kvDriverDecl.credentialKey]
            : dockerDriverDecl
              ? credentials[dockerDriverDecl.credentialKey]
              : undefined;

        let effectiveCs = cs ?? "";
        if (isDocker && cs) {
          effectiveCs = await resolveTunneledHost(accountId, cs);
          dockerHostRef.current = effectiveCs;
        }

        const hostServices = sqlDriverDecl && cs
          ? buildHostServices(sqlDriverDecl.driver, cs)
          : kvDriverDecl && cs
            ? buildKvHostServices(kvDriverDecl.driver, cs)
            : dockerDriverDecl && effectiveCs
              ? buildDockerHostServices(dockerDriverDecl.driver, effectiveCs)
              : undefined;

        if (cs) {
          connectionStringRef.current = cs;
          sqlDriverIdRef.current = sqlDriverDecl?.driver ?? kvDriverDecl?.driver ?? "";
        }

        const client = plugin.createClient(credentials, hostServices);
        clientRef.current = client;
        if (!cancelled) {
          setHasStorageToken(!!client.getStorageAccessToken);
          setCanDelete(!!client.deleteResource);
          setSshConfig(client.getSshConfig ? client.getSshConfig() : null);
        }
        const resourceTypeId = decodedResourceId.split(":")[1] ?? "pg-database";
        const resources = await client.listResources(resourceTypeId, accountId);
        const foundResource = resources.find((r) => r.id === decodedResourceId) ?? resources[0];
        if (!foundResource) throw new Error("Resource not found");

        let enrichedResource: ResourceInstance = foundResource;
        let sqlOk = !!session;

        if (hostServices && isDocker) {
          // Docker plugin — verify connection via version check
          try {
            await client.fetchStats?.();
            if (!cancelled) setAccountConnected(accountId, true);
            sqlOk = true;
          } catch { /* ignore */ }
        } else if (hostServices && cs && isKv) {
          // KV plugin — just verify connection with a PING
          try {
            await client.fetchStats?.();
            if (!cancelled) {
              setKvConnected(true);
              setAccountConnected(accountId, true);
            }
            sqlOk = true;
          } catch { /* ignore — console will show the error on first command */ }
        } else if (client.executeQuery) {
          // REST-based query provider (e.g. BigQuery) — no node SQL driver needed
          try {
            const tables = await client.introspectResource?.(decodedResourceId, accountId) ?? [];
            const tablesJson = JSON.stringify(tables);
            enrichedResource = {
              ...foundResource,
              resolvedOutputs: { ...foundResource.resolvedOutputs, __tables__: tablesJson },
            };
            sqlOk = true;
            if (!cancelled) {
              setPgConnected(true);
              setAccountConnected(accountId, true);
            }
          } catch { /* table listing is non-critical — query still works */ }
        } else if (hostServices && cs) {
          try {
            const tables = await client.introspect?.() ?? [];
            const tablesJson = JSON.stringify(tables);

            enrichedResource = {
              ...foundResource,
              resolvedOutputs: { ...foundResource.resolvedOutputs, __tables__: tablesJson },
            };

            setSqlSession(accountId, { connectionString: cs, tablesJson });

            try {
              const stats = await client.fetchStats?.();
              if (stats) {
                await db.execute(
                  "UPDATE resources SET outputs_json = $1 WHERE id = $2",
                  [JSON.stringify({ pgVersion: stats.version, dbSize: stats.size, tableCount: tables.length }), foundResource.id],
                );
              }
            } catch { /* stats + persist are non-critical */ }

            sqlOk = true;
            if (!cancelled) {
              setPgConnected(true);
              setAccountConnected(accountId, true);
            }
          } catch (err) {
            if (!cancelled && !session) setPgError(String(err));
          }
        }

        if (!cancelled) {
          const detailSchema = client.renderDetail(enrichedResource);
          setSchema(detailSchema);
          setResource(enrichedResource);

          // Resolve SSH host if this resource type declares an sshEndpoint
          const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === enrichedResource.resourceTypeId);
          setResourceTypeLabel(resourceTypeDef?.displayName ?? "Resource");
          if (resourceTypeDef?.sshEndpoint) {
            const { hostOutputKey } = resourceTypeDef.sshEndpoint;
            const host = String(
              enrichedResource.resolvedOutputs[hostOutputKey] ??
              enrichedResource.fields[hostOutputKey] ??
              "",
            );
            if (!cancelled) setSshHost(host || null);
          } else if (!cancelled) {
            setSshHost(null);
          }

          // ── Peer plugin integrations ──────────────────────────────────────
          // Skip on background refreshes — resolveOutput() re-fetches credentials
          // (e.g. DOKS kubeconfig) from the provider API, returning a new token string
          // each time. That causes K9sTerminal to see a changed kubeconfig prop and
          // restart the k9s process on every 30-second tick.
          if (!isBackground) {
            if (resourceTypeDef?.peerIntegrations?.length) {
              const resolvedPanes: PeerPaneData[] = [];
              await Promise.allSettled(
                resourceTypeDef.peerIntegrations.map(async (integration) => {
                  // Resolve all required outputs from this resource
                  const peerCredentials: Record<string, string> = {};
                  for (const mapping of integration.credentialMappings) {
                    const value = await client.resolveOutput(
                      enrichedResource.resourceTypeId,
                      enrichedResource.id,
                      mapping.outputKey,
                      accountId,
                    );
                    peerCredentials[mapping.credentialKey] = value;
                  }

                  const peerLoaded = await getPlugin(integration.pluginId);
                  if (!peerLoaded) return;

                  const peerServices = buildPluginHostServices(peerLoaded.plugin.manifest, peerCredentials);
                  const peerClient = peerLoaded.plugin.createClient(peerCredentials, peerServices);
                  if (!peerClient.renderPeerPane) return;

                  const context: PeerPaneContext = {
                    tabLabel: integration.tabLabel,
                    parentPluginId: plugin.manifest.id,
                    parentResourceTypeId: enrichedResource.resourceTypeId,
                    parentResourceId: enrichedResource.id,
                  };
                  const peerSchema = await peerClient.renderPeerPane(context);

                  resolvedPanes.push({
                    tabLabel: integration.tabLabel,
                    pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
                    credentials: peerCredentials,
                    schema: peerSchema,
                  });
                }),
              );
              if (!cancelled) setPeerPanes(resolvedPanes);
            } else if (!cancelled) {
              setPeerPanes([]);
            }
          }
        }
      } catch (e) {
        if (!cancelled && !isBackground) setError(formatErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [accountId, decodedResourceId, refreshVersion]);

  // Background refresh — auto every 30 s and on manual "Refresh" action
  useEffect(() => {
    function bgRefresh() {
      backgroundRefreshRef.current = true;
      setRefreshVersion((v) => v + 1);
    }
    const id = setInterval(bgRefresh, 30_000);
    window.addEventListener("iw:refresh-resource", bgRefresh);
    return () => { clearInterval(id); window.removeEventListener("iw:refresh-resource", bgRefresh); };
  }, []);

  const handleRunQuery = useCallback(async (sql: string): Promise<QueryResult> => {
    const client = clientRef.current;
    if (client?.executeQuery) {
      return client.executeQuery(decodedResourceId, accountId, sql);
    }
    const cs = connectionStringRef.current;
    const driverId = sqlDriverIdRef.current;
    if (!cs) throw new Error("No active SQL connection");
    const start = performance.now();
    const rows = await sqlQuery(driverId, cs, sql);
    return { rows, durationMs: Math.round(performance.now() - start) };
  }, [decodedResourceId, accountId]);

  const handleExecute = useCallback(async (sql: string, params: unknown[]): Promise<number> => {
    const client = clientRef.current;
    if (client?.executeQuery) {
      await client.executeQuery(decodedResourceId, accountId, sql);
      return 0;
    }
    const cs = connectionStringRef.current;
    const driverId = sqlDriverIdRef.current;
    if (!cs) throw new Error("No active SQL connection");
    return sqlExecute(driverId, cs, sql, params);
  }, [decodedResourceId, accountId]);

  async function handleDelete() {
    if (!resource || !account) return;
    setDeleting(true);
    try {
      const client = clientRef.current;
      if (!client?.deleteResource) throw new Error("Plugin does not support deletion");
      await client.deleteResource(resource.resourceTypeId, resource.id, accountId);
      // Remove from local DB and navigate back to the account page
      const db = await getDb();
      await db.execute("DELETE FROM dashboard_pins WHERE resource_id = $1", [resource.id]);
      await db.execute("DELETE FROM resources WHERE id = $1", [resource.id]);
      removeWorkspaceTabs([
        `resource:${accountId}:${decodedResourceId}`,
        `resource:${accountId}:${decodedResourceId}:ssh`,
        `resource:${accountId}:${decodedResourceId}:sftp`,
      ]);
      window.dispatchEvent(new CustomEvent("iw:resources-changed", { detail: { accountId } }));
      void navigateToWorkspaceTarget(
        navigate,
        accountTabTarget(accountId),
        { label: account.display_name },
      );
    } catch (e) {
      setError(formatErrorMessage(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        Connecting…
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-red-400 text-sm">{error}</div>;
  }

  if (!schema) return null;

  const hasSqlEditor = !!schema?.sqlEditor && pgConnected;
  const hasStorageBrowser = !!schema?.storageBrowser;
  const hasTerminal = !!sshConfig;
  const hasSshPanel = hasTerminal || !!sshHost;
  const currentView = locationHash.replace(/^#/, "");
  const isSshView = currentView === "ssh";
  const isSftpView = currentView === "sftp";
  const hasSftpBrowser = !!sshConfig || !!sshHost;
  const isMongoPlugin = isKvPlugin && kvDriverName === "mongodb";
  const hasCollapsibleDetails = hasStorageBrowser || isMongoPlugin;

  function openSshTab() {
    void navigateToWorkspaceTarget(
      navigate,
      resourceSshTabTarget(accountId, decodedResourceId),
      { label: resource ? `SSH: ${resource.displayName}` : "SSH", mode: "pin" },
    );
  }

  function openSftpTab() {
    void navigateToWorkspaceTarget(
      navigate,
      resourceSftpTabTarget(accountId, decodedResourceId),
      { label: resource ? `SFTP: ${resource.displayName}` : "SFTP", mode: "pin" },
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        {isSftpView && (
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {sshConfig ? (
              <SftpBrowserPanel sftpConfig={sshConfig} initialPath="/" />
            ) : sshHost && quickSshConnection ? (
              <SftpBrowserPanel
                sftpConfig={{ host: sshHost, port: 22, ...quickSshConnection }}
                initialPath="/"
              />
            ) : sshHost ? (
              <SshQuickConnectPanel host={sshHost} onConnect={(config) => setQuickSshConnection(config)} />
            ) : null}
          </div>
        )}

        {!isSshView && !isSftpView && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {(hasSshPanel || hasSftpBrowser) && (
              <div className="shrink-0 flex justify-end gap-2 px-4 py-2 border-b border-gray-800 bg-gray-950">
                {hasSftpBrowser && (
                  <button
                    onClick={openSftpTab}
                    className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-200 border border-gray-800 hover:border-gray-700 rounded-lg transition-colors"
                  >
                    Open SFTP tab
                  </button>
                )}
                {hasSshPanel && (
                  <button
                    onClick={openSshTab}
                    className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-200 border border-gray-800 hover:border-gray-700 rounded-lg transition-colors"
                  >
                    Open SSH tab
                  </button>
                )}
              </div>
            )}
            {hasCollapsibleDetails && (
              <button
                onClick={() => setDetailsCollapsed((c) => !c)}
                className="w-full flex items-center gap-2 px-4 py-1.5 border-b border-gray-800 text-xs text-gray-600 hover:text-gray-400 hover:bg-gray-800/40 transition-colors"
              >
                <span
                  className="inline-block transition-transform text-xs"
                  style={{ transform: detailsCollapsed ? "rotate(0deg)" : "rotate(90deg)" }}
                >
                  ▶
                </span>
                Details
              </button>
            )}
            {!detailsCollapsed && (
              <div className="flex-1 overflow-auto">
                <DetailView
                  schema={schema}
                  resourceId={decodedResourceId}
                  pluginLogoSvg={logoSvg}
                  peerPanes={peerPanes}
                  renderPeerPane={(pane, i) => (
                    <PeerPaneView
                      key={i}
                      pane={pane}
                      accountId={accountId}
                      parentResourceId={decodedResourceId}
                    />
                  )}
                  {...(hasSqlEditor ? { onRunQuery: handleRunQuery, onExecute: handleExecute } : {})}
                />
              </div>
            )}
          </div>
        )}

        {isSshView && (
          <div className="flex-1 min-h-0 overflow-hidden">
            {hasTerminal && sshConfig ? (
              <SshTerminal
                host={sshConfig.host}
                port={sshConfig.port}
                username={sshConfig.username}
                privateKey={sshConfig.privateKey}
              />
            ) : sshHost && quickSshConnection ? (
              <SshTerminal
                host={sshHost}
                port={22}
                username={quickSshConnection.username}
                privateKey={quickSshConnection.privateKey}
              />
            ) : sshHost ? (
              <SshQuickConnectPanel
                host={sshHost}
                onConnect={(config) => setQuickSshConnection(config)}
              />
            ) : null}
          </div>
        )}
      </div>

      {/* SSH bottom bar — connection info + disconnect */}
      {isSshView && (hasTerminal || quickSshConnection) && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-t border-gray-800 bg-gray-950">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          <span className="text-xs font-mono text-gray-400">
            {sshConfig
              ? `${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`
              : quickSshConnection && sshHost
                ? `${quickSshConnection.username}@${sshHost}:22`
                : null}
          </span>
          {quickSshConnection && (
            <button
              onClick={() => setQuickSshConnection(null)}
              className="ml-auto text-xs text-gray-600 hover:text-gray-300 transition-colors"
            >
              Disconnect ✕
            </button>
          )}
        </div>
      )}

      {/* Non-SSH bottom panels — hidden when in SSH view */}
      {!isSshView && !isSftpView && canDelete && (
        <div className="shrink-0 px-4 py-2 border-t border-gray-800 flex items-center justify-end gap-3">
          {confirmDelete ? (
            <>
              <span className="text-xs text-gray-400">
                Permanently delete <span className="text-white font-medium">{resource?.displayName}</span>?
              </span>
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="px-3 py-1 text-xs bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="px-3 py-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
            >
              Delete {resourceTypeLabel}…
            </button>
          )}
        </div>
      )}

      {!isSshView && !isSftpView && !hasSqlEditor && pgError && (
        <div className="shrink-0 px-4 py-2 border-t border-gray-800 bg-gray-950">
          <span className="text-xs text-red-400 font-mono">SQL connection failed: {pgError}</span>
        </div>
      )}

      {!isSshView && !isSftpView && isKvPlugin && kvDriverName === "mongodb" && resource && (
        <MongoDocumentBrowser
          connectionString={connectionStringRef.current}
          databaseName={String(resource.fields["database"] ?? "test")}
          connected={kvConnected}
        />
      )}

      {!isSshView && !isSftpView && isKvPlugin && kvDriverName !== "mongodb" && (
        <KvConsole
          connectionString={connectionStringRef.current}
          driverName={kvDriverName ?? "redis"}
          connected={kvConnected}
        />
      )}

      {!isSshView && !isSftpView && isDockerPlugin && resource && (
        <DockerActionsPanel
          containerId={String(resource.resolvedOutputs["containerId"] ?? resource.externalId ?? "")}
          driverId={dockerDriverName ?? "docker"}
          dockerHost={dockerHostRef.current}
        />
      )}

      {!isSshView && !isSftpView && hasStorageBrowser && (
        <GcsBrowserPanel
          bucketName={schema.storageBrowser!.bucketName}
          onList={(prefix) => clientRef.current!.listStorageObjects!(schema.storageBrowser!.bucketName, prefix)}
          onUpload={(bucket, key, file, onProgress) => clientRef.current!.uploadStorageObject!(bucket, key, file, onProgress)}
          onMakeFolder={(bucket, key) => clientRef.current!.makeStorageFolder!(bucket, key)}
          onDelete={(bucket, key) => clientRef.current!.deleteStorageObject!(bucket, key)}
          {...(hasStorageToken
            ? {
                onBatchDownload: async (keys: string[]) => {
                  const accessToken = await clientRef.current!.getStorageAccessToken!();
                  const result = await invoke<{ canceled?: boolean; filePaths?: string[] }>(
                    "show_open_dialog",
                    { properties: ["openDirectory"], title: "Choose download destination" },
                  );
                  if (result.canceled || !result.filePaths?.[0]) return;
                  const destFolder = result.filePaths[0];
                  await invoke("storage_download_batch", {
                    pluginId: account!.plugin_id,
                    bucket: schema!.storageBrowser!.bucketName,
                    keys,
                    destFolder,
                    accessToken,
                  });
                },
              }
            : {})}
        />
      )}

    </div>
  );
}

// ── Redis Console ─────────────────────────────────────────────────────────────

interface ConsoleLine {
  kind: "input" | "output" | "error";
  text: string;
}

function KvConsole({ connectionString, driverName, connected }: { connectionString: string; driverName: string; connected: boolean }) {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [lines]);

  async function runCommand(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    setLines((prev) => [...prev, { kind: "input", text: `> ${trimmed}` }]);
    setHistory((prev) => [trimmed, ...prev.slice(0, 99)]);
    setHistoryIdx(-1);
    setInput("");
    setRunning(true);

    try {
      const tokens = tokenize(trimmed);
      const [cmd, ...args] = tokens;
      const result = await kvCommand(driverName, connectionString, cmd ?? "", ...args);
      const formatted = formatRedisResult(result);
      setLines((prev) => [...prev, { kind: "output", text: formatted }]);
    } catch (e) {
        setLines((prev) => [...prev, { kind: "error", text: formatErrorMessage(e) }]);
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      void runCommand(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const idx = historyIdx + 1;
      if (idx < history.length) {
        setHistoryIdx(idx);
        setInput(history[idx] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const idx = historyIdx - 1;
      if (idx < 0) {
        setHistoryIdx(-1);
        setInput("");
      } else {
        setHistoryIdx(idx);
        setInput(history[idx] ?? "");
      }
    }
  }

  return (
    <div className="shrink-0 border-t border-gray-800 bg-gray-950 flex flex-col" style={{ height: "220px" }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800/60">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${connected ? "bg-blue-400" : "bg-gray-600"}`} />
        <span className="text-xs text-gray-500 font-medium">Redis Console</span>
        {lines.length > 0 && (
          <button
            onClick={() => setLines([])}
            className="ml-auto text-xs text-gray-700 hover:text-gray-400 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Output */}
      <div ref={outputRef} className="flex-1 overflow-y-auto px-4 py-2 font-mono text-xs space-y-0.5">
        {lines.length === 0 && (
          <span className="text-gray-700">Type a Redis command and press Enter — e.g. PING, KEYS *, GET mykey</span>
        )}
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.kind === "input"
                ? "text-gray-400"
                : line.kind === "error"
                  ? "text-red-400"
                  : "text-green-400"
            }
          >
            {line.text}
          </div>
        ))}
        {running && <div className="text-gray-600 animate-pulse">…</div>}
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-800/60">
        <span className="text-gray-700 font-mono text-xs flex-shrink-0">{">"}</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={connected ? (driverName === "memcached" ? "STATS" : "PING") : "connecting…"}
          disabled={!connected || running}
          className="flex-1 bg-transparent font-mono text-xs text-gray-200 placeholder-gray-700 focus:outline-none disabled:opacity-40"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of cmd) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " ") {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function formatRedisResult(value: unknown): string {
  if (value === null) return "(nil)";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v, i) => `${i + 1}) ${formatRedisResult(v)}`)
      .join("\n");
  }
  return JSON.stringify(value);
}
