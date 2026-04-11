import React, { useState, useEffect, useCallback, useRef } from "react";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
// useDraggable now used inside shared DraggableChildPill from @infrawrench/ui
import { invoke } from "../lib/invoke";
import type { ResourceInstance, DetailViewSchema, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { DetailView, DraggableChildPill, ConfirmDeleteModal, RESOURCES_CHANGED_EVENT, REFRESH_RESOURCE_EVENT, dispatchResourcesChanged, dispatchRefreshResource, resourceTabTitle, buildChildResourceGroups, type QueryResult, type ChildResource, type ChildResourceGroup, type DraggableResource, useUIStore } from "@infrawrench/ui";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { getSqlSession, setSqlSession } from "../lib/sql-session";
import { sqlQuery, sqlExecute, buildHostServices, buildKvHostServices, buildDockerHostServices, buildPluginHostServices } from "../lib/sql-drivers";
import { resolveTunneledHost } from "../lib/ssh-tunnel";
import { DockerActionsPanel } from "../components/DockerActionsPanel";
import { MongoDocumentBrowser } from "../components/MongoDocumentBrowser";
import { GcsBrowserPanel } from "../components/GcsBrowserPanel";
import { SftpBrowserPanel } from "../components/SftpBrowserPanel";
import { SshTerminal } from "../components/SshTerminal";
import { SshQuickConnectPanel } from "../components/SshQuickConnectPanel";
import { KvConsole } from "../components/KvConsole";
import { PeerPaneView } from "../components/PeerPaneView";
import { SshTunnelModal } from "../components/SshTunnelModal";
import { DockerSetupModal } from "../components/DockerSetupModal";
import { CreateResourceModal } from "../components/CreateResourceModal";
import type { PluginClient, PeerPaneContext } from "@infrawrench/plugin-base";
import type { PeerPaneData } from "@infrawrench/ui";
import { accountTabTarget, navigateToWorkspaceTarget, resourceSshTabTarget, resourceSftpTabTarget, resourceTabTarget } from "../lib/workspace-tabs";
// DraggableResource now imported from @infrawrench/ui above
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
  const [showTunnelModal, setShowTunnelModal] = useState(false);
  const [showDockerSetup, setShowDockerSetup] = useState(false);
  const setAccountConnected = useUIStore((s) => s.setAccountConnected);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const locationHash = useRouterState({ select: (s) => s.location.hash });
  const [canDelete, setCanDelete] = useState(false);
  const [resourceTypeLabel, setResourceTypeLabel] = useState<string>("Resource");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [peerPanes, setPeerPanes] = useState<PeerPaneData[]>([]);
  const [childResourceGroups, setChildResourceGroups] = useState<ChildResourceGroup[]>([]);
  const [createChildTarget, setCreateChildTarget] = useState<ResourceTypeDefinition | null>(null);
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
        const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === resourceTypeId);
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

        // When the resource type declares resourceSqlDriver, resolve the
        // connection string from the resource's outputs and enable SQL.
        const rtSqlDriver = resourceTypeDef?.resourceSqlDriver;
        if (rtSqlDriver && !sqlOk) {
          try {
            const rtConnectionString = await client.resolveOutput(
              enrichedResource.resourceTypeId,
              enrichedResource.id,
              rtSqlDriver.connectionStringOutputKey,
              accountId,
            );
            if (rtConnectionString) {
              connectionStringRef.current = rtConnectionString;
              sqlDriverIdRef.current = rtSqlDriver.driver;

              // Introspect via the resolved connection
              try {
                const [tableRows, columnRows, pkRows] = await Promise.all([
                  sqlQuery(rtSqlDriver.driver, rtConnectionString,
                    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"),
                  sqlQuery(rtSqlDriver.driver, rtConnectionString,
                    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position"),
                  sqlQuery(rtSqlDriver.driver, rtConnectionString,
                    "SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'"),
                ]);

                const tables = (tableRows as Array<{ table_name: string }>).map((t) => {
                  const cols = (columnRows as Array<{ table_name: string; column_name: string; data_type: string }>)
                    .filter((c) => c.table_name === t.table_name)
                    .map((c) => ({ name: c.column_name, type: c.data_type }));
                  const pks = (pkRows as Array<{ table_name: string; column_name: string }>)
                    .filter((p) => p.table_name === t.table_name)
                    .map((p) => p.column_name);
                  return { name: t.table_name, columns: cols, ...(pks.length > 0 ? { pkColumns: pks } : {}) };
                });

                enrichedResource = {
                  ...enrichedResource,
                  resolvedOutputs: { ...enrichedResource.resolvedOutputs, __tables__: JSON.stringify(tables) },
                };
                sqlOk = true;
                if (!cancelled) {
                  setPgConnected(true);
                  setAccountConnected(accountId, true);
                }
              } catch {
                // Introspection failed — still enable SQL editor without table metadata
                sqlOk = true;
                if (!cancelled) {
                  setPgConnected(true);
                  setAccountConnected(accountId, true);
                }
              }
            }
          } catch (err) {
            if (!cancelled && !session) setPgError(String(err));
          }
        }

        if (!cancelled) {
          const detailSchema = client.renderDetail(enrichedResource);

          // Inject sqlEditor into the schema if per-resource SQL driver is active
          const finalSchema = (rtSqlDriver && sqlOk && !detailSchema.sqlEditor)
            ? {
                ...detailSchema,
                sqlEditor: {
                  connectionStringOutputKey: rtSqlDriver.connectionStringOutputKey,
                  defaultQuery: "SELECT * FROM information_schema.tables WHERE table_schema = 'public' LIMIT 20;",
                  ...(enrichedResource.resolvedOutputs["__tables__"]
                    ? { tables: JSON.parse(enrichedResource.resolvedOutputs["__tables__"]) }
                    : {}),
                },
              }
            : detailSchema;

          setSchema(finalSchema);
          setResource(enrichedResource);

          const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
          if (activeWorkspaceTabId) {
            const viewSuffix = resourceTabTitle(enrichedResource.displayName, locationHash);
            setWorkspaceTabTitle(activeWorkspaceTabId, viewSuffix);
          }

          // Resolve SSH host if this resource type declares an sshEndpoint
          setResourceTypeLabel(resourceTypeDef?.displayName ?? "Resource");
          if (resourceTypeDef?.sshEndpoint) {
            const { hostOutputKey, runningWhen } = resourceTypeDef.sshEndpoint;
            // If runningWhen is specified, only enable SSH when the field matches
            if (runningWhen) {
              const fieldVal = String(enrichedResource.fields[runningWhen.fieldKey] ?? "");
              if (fieldVal.toLowerCase() !== runningWhen.value.toLowerCase()) {
                if (!cancelled) setSshHost(null);
              } else {
                const host = String(
                  enrichedResource.resolvedOutputs[hostOutputKey] ??
                  enrichedResource.fields[hostOutputKey] ??
                  "",
                );
                if (!cancelled) setSshHost(host || null);
              }
            } else {
              const host = String(
                enrichedResource.resolvedOutputs[hostOutputKey] ??
                enrichedResource.fields[hostOutputKey] ??
                "",
              );
              if (!cancelled) setSshHost(host || null);
            }
          } else if (!cancelled) {
            setSshHost(null);
          }

          const childTypes = plugin.resourceTypes.filter(
            (t) => t.parentTypeId === enrichedResource.resourceTypeId,
          );
          if (childTypes.length > 0) {
            const allChildResources: ChildResource[] = [];
            await Promise.allSettled(
              childTypes.map(async (childType) => {
                try {
                  const resources = await client.listResources(childType.id, accountId);
                  for (const r of resources) {
                    if (r.parentResourceId !== enrichedResource.id) continue;
                    const sidebar = client.renderSidebarItem(r);
                    allChildResources.push({
                      id: r.id,
                      displayName: r.displayName,
                      pluginId: r.pluginId,
                      resourceTypeId: r.resourceTypeId,
                      accountId: r.accountId,
                      status: sidebar.status,
                    });
                  }
                } catch {
                  /* skip failed child type loads */
                }
              }),
            );
            if (!cancelled) {
              setChildResourceGroups(
                buildChildResourceGroups(childTypes, allChildResources) as ChildResourceGroup[],
              );
            }
          } else if (!cancelled) {
            setChildResourceGroups([]);
          }

          // Skip on background refreshes — resolveOutput() re-fetches credentials
          // (e.g. DOKS kubeconfig) from the provider API, returning a new token string
          // each time. That causes K9sTerminal to see a changed kubeconfig prop and
          // restart the k9s process on every 30-second tick.
          if (!isBackground) {
            if (resourceTypeDef?.peerIntegrations?.length) {
              const resolvedPanes: PeerPaneData[] = [];
              await Promise.allSettled(
                resourceTypeDef.peerIntegrations.map(async (integration) => {
                  try {
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
                  } catch {
                    // Peer integration failed (e.g. cluster still provisioning) —
                    // show the tab with a provisioning placeholder instead of hiding it
                    const peerLoaded = await getPlugin(integration.pluginId);
                    if (!peerLoaded) return;
                    resolvedPanes.push({
                      tabLabel: integration.tabLabel,
                      pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
                      credentials: {},
                      schema: {
                        status: { kind: "status-dot", status: "provisioning", label: "Provisioning" },
                        resourceGroups: [],
                      },
                    });
                  }
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
    window.addEventListener(REFRESH_RESOURCE_EVENT, bgRefresh);
    return () => { clearInterval(id); window.removeEventListener(REFRESH_RESOURCE_EVENT, bgRefresh); };
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

  const handleGetManifest = useCallback(async (): Promise<string> => {
    const client = clientRef.current;
    if (!client?.getManifest) throw new Error("Plugin does not support manifest viewing");
    return client.getManifest(decodedResourceId, accountId);
  }, [decodedResourceId, accountId]);

  const handleApplyManifest = useCallback(async (manifest: string): Promise<void> => {
    const client = clientRef.current;
    if (!client?.applyManifest) throw new Error("Plugin does not support manifest editing");
    await client.applyManifest(decodedResourceId, accountId, manifest);
    dispatchRefreshResource();
  }, [decodedResourceId, accountId]);

  async function handleDelete() {
    if (!resource || !account) return;
    const client = clientRef.current;
    if (!client?.deleteResource) throw new Error("Plugin does not support deletion");
    await client.deleteResource(resource.resourceTypeId, resource.id, accountId);
    const db = await getDb();
    await db.execute("DELETE FROM dashboard_pins WHERE resource_id = $1", [resource.id]);
    await db.execute("DELETE FROM resources WHERE id = $1", [resource.id]);
    removeWorkspaceTabs([
      `resource:${accountId}:${decodedResourceId}`,
      `resource:${accountId}:${decodedResourceId}:ssh`,
      `resource:${accountId}:${decodedResourceId}:sftp`,
    ]);
    dispatchResourcesChanged(accountId);
    void navigateToWorkspaceTarget(
      navigate,
      accountTabTarget(accountId),
      { label: account.display_name },
    );
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

  function openSshTab() {
    void navigateToWorkspaceTarget(
      navigate,
      resourceSshTabTarget(accountId, decodedResourceId),
      { label: resourceTabTitle(resource?.displayName ?? "", "ssh") || "SSH", mode: "pin" },
    );
  }

  function openSftpTab() {
    void navigateToWorkspaceTarget(
      navigate,
      resourceSftpTabTarget(accountId, decodedResourceId),
      { label: resourceTabTitle(resource?.displayName ?? "", "sftp") || "SFTP", mode: "pin" },
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
                {sshHost && (
                  <>
                    <button
                      onClick={() => setShowTunnelModal(true)}
                      className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-200 border border-gray-800 hover:border-gray-700 rounded-lg transition-colors"
                    >
                      Connect service via SSH
                    </button>
                    <button
                      onClick={() => setShowDockerSetup(true)}
                      className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-200 border border-gray-800 hover:border-gray-700 rounded-lg transition-colors"
                    >
                      Setup Docker
                    </button>
                  </>
                )}
              </div>
            )}
            {(
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
                  childResourceGroups={childResourceGroups}
                  onChildClick={(child) => {
                    void navigateToWorkspaceTarget(
                      navigate,
                      resourceTabTarget(child.accountId, child.id),
                      { label: child.displayName },
                    );
                  }}
                  onChildCreate={(group) => {
                    const loaded = resource?.pluginId;
                    if (!loaded || !account) return;
                    const typeDef = childResourceGroups
                      .find((g) => g.typeId === group.typeId);
                    if (!typeDef) return;
                    // Find the full ResourceTypeDefinition from the plugin
                    void getPlugin(account.plugin_id).then((p) => {
                      const rt = p?.plugin.resourceTypes.find((t) => t.id === group.typeId);
                      if (rt) setCreateChildTarget(rt);
                    });
                  }}
                  renderChildResource={(child) => (
                    <DraggableChildPill
                      child={child}
                      onOpen={() => {
                        void navigateToWorkspaceTarget(
                          navigate,
                          resourceTabTarget(child.accountId, child.id),
                          { label: child.displayName },
                        );
                      }}
                      extraDragData={{
                        workspaceTabTarget: resourceTabTarget(child.accountId, child.id),
                      }}
                    />
                  )}
                  {...(hasSqlEditor ? { onRunQuery: handleRunQuery, onExecute: handleExecute } : {})}
                  {...(schema.manifestEditor ? { onGetManifest: handleGetManifest, onApplyManifest: handleApplyManifest } : {})}
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
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
          >
            Delete {resourceTypeLabel}…
          </button>
        </div>
      )}

      {confirmDelete && resource && (
        <ConfirmDeleteModal
          kind={resourceTypeLabel.toLowerCase()}
          name={resource.displayName}
          onConfirm={() => handleDelete()}
          onClose={() => setConfirmDelete(false)}
        />
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

      {showTunnelModal && sshHost && (
        <SshTunnelModal
          sshHost={sshHost}
          sourceAccountId={accountId}
          onClose={() => setShowTunnelModal(false)}
          onTunnelEstablished={(newAccountId) => {
            setShowTunnelModal(false);
            void navigateToWorkspaceTarget(navigate, accountTabTarget(newAccountId));
          }}
        />
      )}

      {showDockerSetup && sshHost && (
        <DockerSetupModal
          sshHost={sshHost}
          sourceAccountId={accountId}
          onClose={() => setShowDockerSetup(false)}
          onComplete={(newAccountId) => {
            setShowDockerSetup(false);
            void navigateToWorkspaceTarget(navigate, accountTabTarget(newAccountId));
          }}
        />
      )}

      {createChildTarget && account && (
        <CreateResourceModal
          accountId={accountId}
          pluginId={account.plugin_id}
          resourceType={createChildTarget}
          onClose={() => setCreateChildTarget(null)}
          onCreated={(newResource) => {
            setCreateChildTarget(null);
            dispatchResourcesChanged(accountId);
            // Refresh the current page to show the new child
            backgroundRefreshRef.current = true;
            setRefreshVersion((v) => v + 1);
          }}
        />
      )}

    </div>
  );
}

