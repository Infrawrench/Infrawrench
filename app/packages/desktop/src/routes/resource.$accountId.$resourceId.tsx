import React, { useState, useEffect, useCallback, useRef } from "react";
import { z } from "zod";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { invoke } from "../lib/invoke";
import type {
  ResourceInstance,
  DetailViewSchema,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  ResourceTypeDefinition,
  ArtifactEntry,
  QueryCostEstimate,
  CredentialFormat,
  SecretVersionMutation,
} from "@infrawrench/plugin-base";
import {
  metricSeriesSchema,
  queryResultSchema,
  queryExecuteResultSchema,
  queryCostEstimateSchema,
} from "@infrawrench/plugin-base";
import {
  getCloudAccountDetail,
  listCloudAccountResources,
  syncCloudAccountType,
  getCloudResourceDetail,
  getCloudManifest,
  applyCloudManifest,
  invokeCloudAction,
  runCloudNoSqlCommand,
  getCloudDescribe,
  getCloudLogs,
  deleteCloudResource,
  exportCloudCredential,
  fetchCloudMetrics,
  fetchCloudPeerPanes,
  cloudSqlQuery,
  cloudSqlExecute,
  cloudSqlEstimate,
  cloudListArtifacts,
  listCloudSecretVersions,
  accessCloudSecretVersion,
  addCloudSecretVersion,
  modifyCloudSecretVersion,
} from "../lib/cloud-api";
import {
  DetailView,
  DraggableChildPill,
  ConfirmDeleteModal,
  CredentialExportModal,
  FileBrowser,
  PromptNoSqlCommandModal,
  RESOURCES_CHANGED_EVENT,
  REFRESH_RESOURCE_EVENT,
  NAVIGATE_TO_RESOURCE_EVENT,
  INVOKE_PLUGIN_ACTION_EVENT,
  PROMPT_NOSQL_COMMAND_EVENT,
  dispatchResourcesChanged,
  dispatchRefreshResource,
  resourceTabTitle,
  buildChildResourceGroups,
  formatErrorMessage,
  type QueryResult,
  type ChildResource,
  type ChildResourceGroup,
  type DraggableResource,
  type NavigateToResourceDetail,
  type InvokePluginActionDetail,
  type PromptNoSqlCommandDetail,
  type ResourcePickerOption,
  useUIStore,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import type { AccountRow } from "../db/rows";
import { getPlugin } from "../plugins/loader";
import { getSqlSession, setSqlSession } from "../lib/sql-session";
import {
  sqlQuery,
  sqlExecute,
  buildHostServices,
  buildKvHostServices,
  buildDockerHostServices,
  buildPluginHostServices,
} from "../lib/sql-drivers";
import { resolveTunneledHost } from "../lib/ssh-tunnel";
import { DockerActionsPanel } from "../components/DockerActionsPanel";
import { MongoDocumentBrowser } from "../components/MongoDocumentBrowser";
import { FirestoreDocumentBrowser } from "@infrawrench/ui";
import { FirestoreMongoPeerBrowser } from "../components/FirestoreMongoPeerBrowser";
import { SftpBrowserPanel } from "../components/SftpBrowserPanel";
import { SshTerminal } from "../components/SshTerminal";
import { SshQuickConnectPanel } from "../components/SshQuickConnectPanel";
import { KvConsole } from "../components/KvConsole";
import { PeerPaneView } from "../components/PeerPaneView";
import { K8sExecPanel } from "../components/K8sExecPanel";
import { SshTunnelModal } from "../components/SshTunnelModal";
import { DockerSetupModal } from "../components/DockerSetupModal";
import { CreateResourceModal } from "../components/CreateResourceModal";
import { SpotlightSearch } from "../components/SpotlightSearch";
import { createPluginClient } from "../lib/plugin-client";
import type { PluginClient, PeerPaneContext, AssociationSource } from "@infrawrench/plugin-base";
import type { PeerPaneData } from "@infrawrench/ui";
import {
  accountTabTarget,
  navigateToWorkspaceTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  resourceTabTarget,
} from "../lib/workspace-tabs";

export const Route = createFileRoute("/resource/$accountId/$resourceId")({
  component: ResourceDetailPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { plugin?: string; type?: string; parent?: string } => ({
    ...(typeof search["plugin"] === "string" ? { plugin: search["plugin"] } : {}),
    ...(typeof search["type"] === "string" ? { type: search["type"] } : {}),
    ...(typeof search["parent"] === "string" ? { parent: search["parent"] } : {}),
  }),
});

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
  const { plugin: peerPlugin, type: peerType, parent: peerParent } = Route.useSearch();

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
  const cloudCtxRef = useRef<{
    orgId: string;
    pluginId: string;
    resourceTypeId: string;
    parentResourceId?: string;
  } | null>(null);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [hasStorageToken, setHasStorageToken] = useState(false);
  const [sshConfig, setSshConfig] = useState<{
    host: string;
    port: number;
    username: string;
    privateKey: string;
  } | null>(null);
  const [sshHost, setSshHost] = useState<string | null>(null);
  const [sshDefaultUsername, setSshDefaultUsername] = useState<string | null>(null);
  const [quickSshConnection, setQuickSshConnection] = useState<{
    username: string;
    privateKey: string;
    keySource: import("../lib/ssh-key-source").KeySource;
  } | null>(null);
  const [showTunnelModal, setShowTunnelModal] = useState(false);
  const [showDockerSetup, setShowDockerSetup] = useState(false);
  const [showDropSpotlight, setShowDropSpotlight] = useState(false);
  const setAccountConnected = useUIStore((s) => s.setAccountConnected);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const locationHash = useRouterState({ select: (s) => s.location.hash });
  const [canDelete, setCanDelete] = useState(false);
  const [credentialFormats, setCredentialFormats] = useState<CredentialFormat[]>([]);
  const [showExportCredential, setShowExportCredential] = useState(false);
  const [resourceTypeLabel, setResourceTypeLabel] = useState<string>("Resource");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [peerPanes, setPeerPanes] = useState<PeerPaneData[]>([]);
  const [childResourceGroups, setChildResourceGroups] = useState<ChildResourceGroup[]>([]);
  const [createChildTarget, setCreateChildTarget] = useState<ResourceTypeDefinition | null>(null);
  const [metricSeries, setMetricSeries] = useState<MetricSeries[] | undefined>(undefined);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const backgroundRefreshRef = useRef(false);
  const loadingRef = useRef(true);
  const peerPanesHydratingRef = useRef(false);
  const peerPanesRef = useRef<PeerPaneData[]>([]);
  const handlePeerPaneOpenRef = useRef<(() => void) | null>(null);
  const localPeerCtxRef = useRef<{
    peerIntegrations: ResourceTypeDefinition["peerIntegrations"];
    parentPluginId: string;
    parentResourceTypeId: string;
    parentResourceId: string;
  } | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const isBackground = backgroundRefreshRef.current;
    backgroundRefreshRef.current = false;
    if (!isBackground) {
      peerPanesHydratingRef.current = false;
      localPeerCtxRef.current = null;
      cloudCtxRef.current = null;
      clientRef.current = null;
      setLoading(true);
      setError(null);
      setPgError(null);
      setSchema(null);
      setResource(null);
      setAccount(null);
      setLogoSvg("");
      setPeerPanes([]);
      setChildResourceGroups([]);
      setMetricSeries(undefined);
    }

    async function loadCloud(orgId: string) {
      const accountDetail = await getCloudAccountDetail(orgId, accountId);
      if (!accountDetail) throw new Error("Account not found");

      let pluginId = accountDetail.account.pluginId;
      let resourceTypeId: string | null = null;

      if (peerPlugin && peerType) {
        pluginId = peerPlugin;
        resourceTypeId = peerType;
      } else {
        const topLevel = await listCloudAccountResources(orgId, accountId).catch(() => []);
        const topMatch = topLevel.find((r) => r.id === decodedResourceId);
        if (topMatch) {
          pluginId = topMatch.pluginId;
          resourceTypeId = topMatch.resourceTypeId;
        } else {
          for (const typeDef of accountDetail.resourceTypes) {
            const items = await syncCloudAccountType(orgId, accountId, typeDef.id).catch(() => []);
            const match = items.find((r) => r.id === decodedResourceId);
            if (match) {
              pluginId = match.pluginId;
              resourceTypeId = match.resourceTypeId;
              break;
            }
          }
        }
      }

      if (!resourceTypeId) throw new Error("Resource not found");

      const detail = (await getCloudResourceDetail(
        orgId,
        pluginId,
        resourceTypeId,
        decodedResourceId,
        accountId,
        peerParent,
        { includePeerPanes: false },
      )) as {
        detailSchema: DetailViewSchema;
        pluginLogoSvg: string;
        resourceDisplayName: string;
        resourceTypeLabel: string;
        resourceFields?: Record<string, string | number | boolean>;
        canDelete: boolean;
        credentialFormats?: CredentialFormat[];
        hasSqlEditor: boolean;
        hasKvConsole: boolean;
        kvDriverName?: string;
        hasDockerActions: boolean;
        sshHost: string | null;
        defaultSshUsername: string | null;
        supportsMetrics: boolean;
        childTypes: Array<{
          id: string;
          displayName: string;
          pluralDisplayName: string;
          supportsCreate: boolean;
        }>;
        childResources: ChildResource[];
        peerPanes: Array<{
          tabLabel: string;
          pluginLogoSvg: string;
          schema: PeerPaneData["schema"];
          peerPluginId: string;
        }>;
        peerIntegrationStubs?: Array<{
          tabLabel: string;
          pluginLogoSvg: string;
          peerPluginId: string;
        }>;
      };

      if (cancelled) return;

      const now = new Date().toISOString();
      const cloudResource: ResourceInstance = {
        id: decodedResourceId,
        pluginId,
        resourceTypeId,
        accountId,
        displayName: detail.resourceDisplayName,
        fields: detail.resourceFields ?? {},
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      };

      cloudCtxRef.current = {
        orgId,
        pluginId,
        resourceTypeId,
        ...(peerParent ? { parentResourceId: peerParent } : {}),
      };
      clientRef.current = null;

      // Strip storageBrowser from cloud schema — storage requires a local client
      // until cloud storage endpoints land.
      const { storageBrowser: _storageBrowser, ...restSchema } = detail.detailSchema;
      void _storageBrowser;

      setAccount({
        id: accountId,
        plugin_id: pluginId,
        display_name: accountDetail.account.displayName,
        encrypted_credentials: "",
        credentials_iv: "",
      });
      setLogoSvg(detail.pluginLogoSvg);
      setResource(cloudResource);
      setResourceTypeLabel(detail.resourceTypeLabel);
      setSchema(restSchema);
      setCanDelete(detail.canDelete);
      setCredentialFormats(detail.credentialFormats ?? []);
      setSshHost(detail.sshHost);
      setSshDefaultUsername(detail.defaultSshUsername);
      setPgConnected(detail.hasSqlEditor);
      setIsKvPlugin(detail.hasKvConsole);
      setKvDriverName(detail.kvDriverName ?? null);
      setKvConnected(detail.hasKvConsole);
      setIsDockerPlugin(detail.hasDockerActions);
      setDockerDriverName(null);
      setChildResourceGroups(
        buildChildResourceGroups(
          detail.childTypes.map((ct) => ({
            id: ct.id,
            displayName: ct.displayName,
            pluralDisplayName: ct.pluralDisplayName,
            supportsCreate: ct.supportsCreate,
          })) as ResourceTypeDefinition[],
          detail.childResources,
        ) as ChildResourceGroup[],
      );

      // Peer panes: use stubs on initial load, hydrate lazily when a tab is
      // opened. Preserve already-hydrated panes across background refreshes so
      // we don't lose state.
      const stubs = detail.peerIntegrationStubs ?? [];
      const eagerPanes = detail.peerPanes ?? [];
      if (eagerPanes.length > 0) {
        setPeerPanes(
          eagerPanes.map((p) => ({
            tabLabel: p.tabLabel,
            pluginLogoSvg: p.pluginLogoSvg,
            credentials: {},
            schema: p.schema,
          })),
        );
      } else if (isBackground) {
        setPeerPanes((prev) => {
          if (prev.length > 0) return prev;
          return stubs.map((s) => ({
            tabLabel: s.tabLabel,
            pluginLogoSvg: s.pluginLogoSvg,
            credentials: {},
            schema: { resourceGroups: [] },
            loading: true,
          }));
        });
      } else {
        setPeerPanes(
          stubs.map((s) => ({
            tabLabel: s.tabLabel,
            pluginLogoSvg: s.pluginLogoSvg,
            credentials: {},
            schema: { resourceGroups: [] },
            loading: true,
          })),
        );
      }

      const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
      if (activeWorkspaceTabId) {
        const viewSuffix = resourceTabTitle(detail.resourceDisplayName, locationHash);
        setWorkspaceTabTitle(activeWorkspaceTabId, viewSuffix);
      }

      setAccountConnected(accountId, true);

      if (detail.supportsMetrics && !isBackground) {
        fetchCloudMetrics(orgId, pluginId, resourceTypeId, {
          accountId,
          resourceId: decodedResourceId,
        })
          .then((series) => {
            if (!cancelled)
              setMetricSeries(z.array(metricSeriesSchema).parse(series) as MetricSeries[]);
          })
          .catch(() => {});
      }
    }

    async function loadLocalPeer() {
      const db = await getDb();
      const accountRows = await db.select<AccountRow[]>(
        "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
        [accountId],
      );
      const accountRow = accountRows[0];
      if (!accountRow) throw new Error("Account not found");

      const plaintext = await invoke<string>("decrypt_value", {
        ciphertext: accountRow.encrypted_credentials,
        iv: accountRow.credentials_iv,
      });
      const parentCredentials = JSON.parse(plaintext) as Record<string, string>;

      const parentLoaded = await getPlugin(accountRow.plugin_id);
      if (!parentLoaded) throw new Error(`Plugin "${accountRow.plugin_id}" not loaded`);

      const parentHostServices = buildPluginHostServices(
        parentLoaded.plugin.manifest,
        parentCredentials,
      );
      const parentClient = parentLoaded.plugin.createClient(parentCredentials, parentHostServices);

      const parentTypeId = peerParent!.split(":")[1];
      if (!parentTypeId) throw new Error("Cannot parse parent resource type");

      const parentTypeDef = parentLoaded.plugin.resourceTypes.find((t) => t.id === parentTypeId);
      const integration = parentTypeDef?.peerIntegrations?.find((i) => i.pluginId === peerPlugin);
      if (!integration) throw new Error(`No peer integration for ${peerPlugin}`);

      const peerCredentials: Record<string, string> = {};
      for (const mapping of integration.credentialMappings) {
        const value = await parentClient.resolveOutput(
          parentTypeId,
          peerParent!,
          mapping.outputKey,
          accountId,
        );
        peerCredentials[mapping.credentialKey] = value;
      }

      const peerLoaded = await getPlugin(peerPlugin!);
      if (!peerLoaded) throw new Error(`Plugin "${peerPlugin}" not loaded`);
      const peerHostServices = buildPluginHostServices(peerLoaded.plugin.manifest, peerCredentials);
      const peerClient = peerLoaded.plugin.createClient(peerCredentials, peerHostServices);
      clientRef.current = peerClient;

      const peerResources = await peerClient.listResources(peerType!, accountId);
      const found = peerResources.find((r) => r.id === decodedResourceId);
      if (!found) throw new Error("Resource not found");

      if (cancelled) return;

      const peerTypeDef = peerLoaded.plugin.resourceTypes.find((t) => t.id === peerType);
      const detailSchema = peerClient.renderDetail(found);

      const peerKvDriver = peerLoaded.plugin.manifest.kvDriver;
      const peerKvConnectionString = peerKvDriver
        ? (peerCredentials[peerKvDriver.credentialKey] ?? "")
        : "";
      connectionStringRef.current = peerKvConnectionString;

      setAccount(accountRow);
      setLogoSvg(peerLoaded.plugin.manifest.logoSvg);
      setResource(found);
      setResourceTypeLabel(peerTypeDef?.displayName ?? "Resource");
      setSchema(detailSchema);
      setCanDelete(!!peerClient.deleteResource);
      setSshHost(null);
      setSshDefaultUsername(null);
      setPgConnected(false);
      setIsKvPlugin(!!peerKvDriver);
      setKvDriverName(peerKvDriver?.driver ?? null);
      setKvConnected(!!peerKvConnectionString);
      setIsDockerPlugin(false);
      setDockerDriverName(null);
      setChildResourceGroups([]);
      setPeerPanes([]);
      localPeerCtxRef.current = null;
      setAccountConnected(accountId, true);

      const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
      if (activeWorkspaceTabId) {
        const viewSuffix = resourceTabTitle(found.displayName, locationHash);
        setWorkspaceTabTitle(activeWorkspaceTabId, viewSuffix);
      }
    }

    async function load() {
      if (!isBackground) {
        setError(null);
        setPgError(null);
      }

      try {
        const orgId = useUIStore.getState().activeCloudOrgId;
        if (orgId) {
          await loadCloud(orgId);
          return;
        }

        cloudCtxRef.current = null;

        if (peerPlugin && peerType && peerParent) {
          await loadLocalPeer();
          return;
        }

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
              const fastTypeDef = loaded.plugin.resourceTypes.find(
                (t) => t.id === sqliteRes.resource_type_id,
              );
              const now = new Date().toISOString();
              const immediateResource: ResourceInstance = {
                id: sqliteRes.id,
                pluginId: sqliteRes.plugin_id,
                resourceTypeId: sqliteRes.resource_type_id,
                accountId: sqliteRes.account_id,
                displayName: sqliteRes.display_name,
                externalId: sqliteRes.external_id,
                fields: (() => {
                  try {
                    return JSON.parse(sqliteRes.fields_json);
                  } catch {
                    return {};
                  }
                })(),
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
              const immediateSchema = loaded.plugin
                .createClient({ connectionString: session.connectionString }, fastServices)
                .renderDetail(immediateResource);
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

        const hostServices =
          sqlDriverDecl && cs
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
        const resourceTypeId = decodedResourceId.split(":")[1] ?? "pg-database";
        const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === resourceTypeId);
        if (!cancelled) {
          setHasStorageToken(!!client.getStorageAccessToken);
          setCanDelete(!!client.deleteResource);
          setCredentialFormats(
            client.exportCredential && resourceTypeDef?.credentialFormats
              ? resourceTypeDef.credentialFormats
              : [],
          );
          setSshConfig(client.getSshConfig ? client.getSshConfig() : null);
        }
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
          } catch {
            /* ignore */
          }
        } else if (hostServices && cs && isKv) {
          // KV plugin — just verify connection with a PING
          try {
            await client.fetchStats?.();
            if (!cancelled) {
              setKvConnected(true);
              setAccountConnected(accountId, true);
            }
            sqlOk = true;
          } catch {
            /* ignore — console will show the error on first command */
          }
        } else if (client.executeQuery) {
          // REST-based query provider (e.g. BigQuery) — no node SQL driver needed
          try {
            const tables = (await client.introspectResource?.(decodedResourceId, accountId)) ?? [];
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
          } catch {
            /* table listing is non-critical — query still works */
          }
        } else if (hostServices && cs) {
          try {
            const tables = (await client.introspect?.()) ?? [];
            const tablesJson = JSON.stringify(tables);

            enrichedResource = {
              ...foundResource,
              resolvedOutputs: { ...foundResource.resolvedOutputs, __tables__: tablesJson },
            };

            setSqlSession(accountId, { connectionString: cs, tablesJson });

            try {
              const stats = await client.fetchStats?.();
              if (stats) {
                await db.execute("UPDATE resources SET outputs_json = $1 WHERE id = $2", [
                  JSON.stringify({
                    pgVersion: stats.version,
                    dbSize: stats.size,
                    tableCount: tables.length,
                  }),
                  foundResource.id,
                ]);
              }
            } catch {
              /* stats + persist are non-critical */
            }

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

              // Expose the resolved connection string to renderDetail so plugins
              // can display it (e.g. Neon database Connection String field) without
              // doing async work themselves.
              enrichedResource = {
                ...enrichedResource,
                resolvedOutputs: {
                  ...enrichedResource.resolvedOutputs,
                  [rtSqlDriver.connectionStringOutputKey]: rtConnectionString,
                },
              };

              // Introspect via the resolved connection
              try {
                const [tableRows, columnRows, pkRows] = await Promise.all([
                  sqlQuery(
                    rtSqlDriver.driver,
                    rtConnectionString,
                    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
                  ),
                  sqlQuery(
                    rtSqlDriver.driver,
                    rtConnectionString,
                    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
                  ),
                  sqlQuery(
                    rtSqlDriver.driver,
                    rtConnectionString,
                    "SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'",
                  ),
                ]);

                const tables = (tableRows as Array<{ table_name: string }>).map((t) => {
                  const cols = (
                    columnRows as Array<{
                      table_name: string;
                      column_name: string;
                      data_type: string;
                    }>
                  )
                    .filter((c) => c.table_name === t.table_name)
                    .map((c) => ({ name: c.column_name, type: c.data_type }));
                  const pks = (pkRows as Array<{ table_name: string; column_name: string }>)
                    .filter((p) => p.table_name === t.table_name)
                    .map((p) => p.column_name);
                  return {
                    name: t.table_name,
                    columns: cols,
                    ...(pks.length > 0 ? { pkColumns: pks } : {}),
                  };
                });

                enrichedResource = {
                  ...enrichedResource,
                  resolvedOutputs: {
                    ...enrichedResource.resolvedOutputs,
                    __tables__: JSON.stringify(tables),
                  },
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
          if (client.enrichDetail) {
            try {
              enrichedResource = await client.enrichDetail(enrichedResource);
            } catch {
              /* enrichment is best-effort */
            }
          }
          const detailSchema = client.renderDetail(enrichedResource);

          // Inject sqlEditor into the schema if per-resource SQL driver is active
          const finalSchema =
            rtSqlDriver && sqlOk && !detailSchema.sqlEditor
              ? {
                  ...detailSchema,
                  sqlEditor: {
                    connectionStringOutputKey: rtSqlDriver.connectionStringOutputKey,
                    defaultQuery:
                      "SELECT * FROM information_schema.tables WHERE table_schema = 'public' LIMIT 20;",
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

          // Resolve SSH host and default username if this resource type declares an sshEndpoint
          setResourceTypeLabel(resourceTypeDef?.displayName ?? "Resource");
          if (resourceTypeDef?.sshEndpoint) {
            const { hostOutputKey, runningWhen, usernameFieldKey, defaultUsername } =
              resourceTypeDef.sshEndpoint;
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
            // Resolve SSH username
            if (!cancelled) {
              let resolvedUsername: string | null = null;
              if (usernameFieldKey) {
                const val = String(enrichedResource.fields[usernameFieldKey] ?? "");
                if (val) resolvedUsername = val;
              }
              if (!resolvedUsername && defaultUsername) resolvedUsername = defaultUsername;
              setSshDefaultUsername(resolvedUsername);
            }
          } else if (!cancelled) {
            setSshHost(null);
            setSshDefaultUsername(null);
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

          // Peer panes are lazy-fetched on tab click via handlePeerPaneOpen.
          // Expose stubs (tab label + logo) so tabs render immediately, and
          // stash the context needed for the lazy fetch. Preserve hydrated
          // panes across background refreshes so the user doesn't lose state.
          if (resourceTypeDef?.peerIntegrations?.length) {
            const integrationFields = enrichedResource.fields ?? {};
            const visibleIntegrations = resourceTypeDef.peerIntegrations.filter((i) => {
              if (!i.showWhen) return true;
              const v = integrationFields[i.showWhen.fieldKey];
              if (v == null || v === "") return false;
              const s = String(v);
              if (i.showWhen.equals != null) return s === i.showWhen.equals;
              if (i.showWhen.prefix != null) return s.startsWith(i.showWhen.prefix);
              return true;
            });
            localPeerCtxRef.current = {
              peerIntegrations: visibleIntegrations,
              parentPluginId: plugin.manifest.id,
              parentResourceTypeId: enrichedResource.resourceTypeId,
              parentResourceId: enrichedResource.id,
            };
            const stubPanes: PeerPaneData[] = [];
            for (const integration of visibleIntegrations) {
              const peerLoaded = await getPlugin(integration.pluginId);
              if (!peerLoaded) continue;
              stubPanes.push({
                tabLabel: integration.tabLabel,
                pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
                credentials: {},
                schema: { resourceGroups: [] },
                loading: true,
              });
            }
            if (!cancelled) {
              if (isBackground) {
                setPeerPanes((prev) => (prev.length > 0 ? prev : stubPanes));
              } else {
                setPeerPanes(stubPanes);
              }
            }
          } else {
            localPeerCtxRef.current = null;
            if (!cancelled && !isBackground) setPeerPanes([]);
          }

          // Fetch time-series metrics if supported
          if (resourceTypeDef?.supportsMetrics && client.fetchMetricSeries && !isBackground) {
            client
              .fetchMetricSeries(enrichedResource.resourceTypeId, enrichedResource.id, accountId)
              .then((series) => {
                if (!cancelled) setMetricSeries(series);
              })
              .catch(() => {});
          }
        }
      } catch (e) {
        if (!cancelled && !isBackground) {
          setError(formatErrorMessage(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    decodedResourceId,
    refreshVersion,
    activeCloudOrgId,
    peerPlugin,
    peerType,
    peerParent,
  ]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    peerPanesRef.current = peerPanes;
  }, [peerPanes]);

  // Background refresh — auto every 30 s and on manual "Refresh" action
  useEffect(() => {
    function bgRefresh() {
      if (loadingRef.current) return; // skip if a navigation is already in flight
      const hasHydratedPanes = peerPanesRef.current.some((p) => !p.loading);
      backgroundRefreshRef.current = true;
      setRefreshVersion((v) => v + 1);
      if (hasHydratedPanes && handlePeerPaneOpenRef.current) {
        peerPanesHydratingRef.current = false;
        handlePeerPaneOpenRef.current();
      }
    }
    const id = setInterval(bgRefresh, 30_000);
    window.addEventListener(REFRESH_RESOURCE_EVENT, bgRefresh);
    return () => {
      clearInterval(id);
      window.removeEventListener(REFRESH_RESOURCE_EVENT, bgRefresh);
    };
  }, []);

  // Listen for schema-emitted navigate-to-resource actions. The target account
  // is the first colon-segment of the resource ID (see ListerContext.id).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NavigateToResourceDetail>).detail;
      if (!detail) return;
      const targetAccountId = detail.resourceId.split(":")[0] ?? accountId;
      void navigateToWorkspaceTarget(
        navigate,
        resourceTabTarget(
          targetAccountId,
          detail.resourceId,
          detail.pluginId,
          detail.resourceTypeId,
        ),
      );
    };
    window.addEventListener(NAVIGATE_TO_RESOURCE_EVENT, handler);
    return () => window.removeEventListener(NAVIGATE_TO_RESOURCE_EVENT, handler);
  }, [navigate, accountId]);

  // Listen for schema-emitted plugin-action events and dispatch to either the
  // cloud backend or the local plugin client, then refresh the view.
  useEffect(() => {
    async function handler(e: Event) {
      const detail = (e as CustomEvent<InvokePluginActionDetail>).detail;
      if (!detail) return;
      if (detail.confirmMessage && !window.confirm(detail.confirmMessage)) return;
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) return;
      try {
        if (cloud) {
          await invokeCloudAction(cloud.orgId, {
            pluginId: cloud.pluginId,
            accountId,
            resourceTypeId: res.resourceTypeId,
            resourceId: decodedResourceId,
            actionId: detail.actionId,
            ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
          });
        } else {
          const client = clientRef.current;
          if (!client?.invokeAction) {
            throw new Error("Plugin does not support custom actions");
          }
          await client.invokeAction(
            res.resourceTypeId,
            decodedResourceId,
            detail.actionId,
            accountId,
          );
        }
        if (detail.successMessage) {
          window.alert(detail.successMessage);
        }
        dispatchRefreshResource();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Action failed");
      }
    }
    window.addEventListener(INVOKE_PLUGIN_ACTION_EVENT, handler);
    return () => window.removeEventListener(INVOKE_PLUGIN_ACTION_EVENT, handler);
  }, [accountId, decodedResourceId, resource]);

  const handleNoSqlCommand = useCallback(
    async (command: string, args: (string | number)[]): Promise<unknown> => {
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) throw new Error("Resource not loaded");
      if (cloud) {
        return runCloudNoSqlCommand(cloud.orgId, {
          pluginId: cloud.pluginId,
          accountId,
          resourceTypeId: res.resourceTypeId,
          resourceId: decodedResourceId,
          command,
          args,
          ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
        });
      }
      const client = clientRef.current;
      if (!client?.executeNoSqlCommand) {
        throw new Error("Plugin does not support NoSQL commands");
      }
      return client.executeNoSqlCommand(
        res.resourceTypeId,
        decodedResourceId,
        accountId,
        command,
        args,
      );
    },
    [accountId, decodedResourceId, resource],
  );

  // Modal state for prompt-nosql-command. Electron renderer doesn't
  // implement window.prompt, so we use an in-app modal for field input.
  const [promptModal, setPromptModal] = useState<PromptNoSqlCommandDetail | null>(null);

  // Resolves resource-picker options for any resource-picker fields used in
  // a prompt-nosql-command form (e.g. picking a Pub/Sub topic when creating
  // an Eventarc trigger).
  const loadPromptResources = useCallback(
    async (sources: AssociationSource[], acctId: string): Promise<ResourcePickerOption[]> => {
      const results: ResourcePickerOption[] = [];
      const localClients = new Map<string, Promise<PluginClient>>();
      const getLocalClient = (a: string, p: string) => {
        const key = `${a}:${p}`;
        let existing = localClients.get(key);
        if (!existing) {
          existing = createPluginClient(a, p);
          localClients.set(key, existing);
        }
        return existing;
      };
      for (const source of sources) {
        try {
          const client = await getLocalClient(acctId, source.pluginId);
          const resources = await client.listResources(source.resourceTypeId, acctId);
          for (const resource of resources) {
            try {
              // Prefer the value the lister already populated — avoids an N+1
              // re-list when resolveOutput would just re-fetch the same data.
              const preResolved = resource.resolvedOutputs[source.outputKey];
              const outputValue =
                preResolved != null && String(preResolved) !== ""
                  ? String(preResolved)
                  : client.resolveOutput
                    ? await client.resolveOutput(
                        source.resourceTypeId,
                        resource.id,
                        source.outputKey,
                        acctId,
                      )
                    : "";
              results.push({
                id: resource.id,
                label: resource.displayName,
                pluginId: source.pluginId,
                resourceTypeId: source.resourceTypeId,
                accountId: acctId,
                outputKey: source.outputKey,
                outputValue,
              });
            } catch {
              /* skip resources whose output can't be resolved */
            }
          }
        } catch {
          /* skip sources whose plugin isn't loaded for this account */
        }
      }
      return results;
    },
    [],
  );

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<PromptNoSqlCommandDetail>).detail;
      if (!detail) return;
      setPromptModal(detail);
    }
    window.addEventListener(PROMPT_NOSQL_COMMAND_EVENT, handler);
    return () => window.removeEventListener(PROMPT_NOSQL_COMMAND_EVENT, handler);
  }, []);

  const handleRunQuery = useCallback(
    async (sql: string): Promise<QueryResult> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const raw = await cloudSqlQuery(cloud.orgId, {
          accountId,
          resourceId: decodedResourceId,
          resourceTypeId: cloud.resourceTypeId,
          sql,
        });
        return queryResultSchema.parse(raw);
      }
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
    },
    [decodedResourceId, accountId],
  );

  const handleExecute = useCallback(
    async (sql: string, params: unknown[]): Promise<number> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const result = queryExecuteResultSchema.parse(
          await cloudSqlExecute(cloud.orgId, {
            accountId,
            resourceId: decodedResourceId,
            resourceTypeId: cloud.resourceTypeId,
            sql,
            params,
          }),
        );
        return result.affectedRows ?? 0;
      }
      const client = clientRef.current;
      if (client?.executeQuery) {
        await client.executeQuery(decodedResourceId, accountId, sql);
        return 0;
      }
      const cs = connectionStringRef.current;
      const driverId = sqlDriverIdRef.current;
      if (!cs) throw new Error("No active SQL connection");
      return sqlExecute(driverId, cs, sql, params);
    },
    [decodedResourceId, accountId],
  );

  const handleEstimateQueryCost = useCallback(
    async (sql: string): Promise<QueryCostEstimate> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        return queryCostEstimateSchema.parse(
          await cloudSqlEstimate(cloud.orgId, {
            accountId,
            resourceId: decodedResourceId,
            sql,
          }),
        ) as QueryCostEstimate;
      }
      const client = clientRef.current;
      if (!client?.estimateQueryCost) {
        throw new Error("Query cost estimation is not supported for this resource");
      }
      return client.estimateQueryCost(decodedResourceId, accountId, sql);
    },
    [decodedResourceId, accountId],
  );

  const handleGetManifest = useCallback(async (): Promise<string> => {
    const cloud = cloudCtxRef.current;
    if (cloud) {
      const r = await getCloudManifest(
        cloud.orgId,
        cloud.pluginId,
        cloud.resourceTypeId,
        decodedResourceId,
        accountId,
        cloud.parentResourceId,
      );
      return r.manifest;
    }
    const client = clientRef.current;
    if (!client?.getManifest) throw new Error("Plugin does not support manifest viewing");
    return client.getManifest(decodedResourceId, accountId);
  }, [decodedResourceId, accountId]);

  const handleApplyManifest = useCallback(
    async (manifest: string): Promise<void> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        await applyCloudManifest(cloud.orgId, cloud.pluginId, cloud.resourceTypeId, {
          accountId,
          resourceId: decodedResourceId,
          manifest,
          ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
        });
        dispatchRefreshResource();
        return;
      }
      const client = clientRef.current;
      if (!client?.applyManifest) throw new Error("Plugin does not support manifest editing");
      await client.applyManifest(decodedResourceId, accountId, manifest);
      dispatchRefreshResource();
    },
    [decodedResourceId, accountId],
  );

  const handleGetDescribe = useCallback(async (): Promise<string> => {
    const cloud = cloudCtxRef.current;
    if (cloud) {
      const r = await getCloudDescribe(
        cloud.orgId,
        cloud.pluginId,
        cloud.resourceTypeId,
        decodedResourceId,
        accountId,
        cloud.parentResourceId,
      );
      return r.text;
    }
    const client = clientRef.current;
    if (!client?.describeResource) throw new Error("Plugin does not support describe");
    return client.describeResource(resource?.resourceTypeId ?? "", decodedResourceId, accountId);
  }, [decodedResourceId, accountId, resource]);

  const handleGetLogs = useCallback(
    async (params: LogsFetchParams): Promise<LogsFetchResult> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        return getCloudLogs(
          cloud.orgId,
          cloud.pluginId,
          cloud.resourceTypeId,
          decodedResourceId,
          accountId,
          {
            ...params,
            ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
          },
        );
      }
      const client = clientRef.current;
      if (!client?.getLogs) throw new Error("Plugin does not support logs");
      return client.getLogs(resource?.resourceTypeId ?? "", decodedResourceId, accountId, params);
    },
    [decodedResourceId, accountId, resource],
  );

  const handleListArtifacts = useCallback(
    async (params: {
      pageToken?: string;
      prefix?: string;
    }): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        return (await cloudListArtifacts(cloud.orgId, {
          accountId,
          resourceId: decodedResourceId,
          resourceTypeId: cloud.resourceTypeId,
          ...params,
        })) as { items: ArtifactEntry[]; nextPageToken?: string };
      }
      const client = clientRef.current;
      if (!client?.listArtifacts) throw new Error("Plugin does not support listing artifacts");
      return client.listArtifacts(
        resource?.resourceTypeId ?? "",
        decodedResourceId,
        accountId,
        params,
      );
    },
    [decodedResourceId, accountId, resource],
  );

  const handleListSecretVersions = useCallback(async () => {
    const cloud = cloudCtxRef.current;
    if (cloud) {
      const r = await listCloudSecretVersions(
        cloud.orgId,
        cloud.pluginId,
        cloud.resourceTypeId,
        decodedResourceId,
        accountId,
        cloud.parentResourceId,
      );
      return r.versions;
    }
    const client = clientRef.current;
    if (!client?.listSecretVersions) throw new Error("Plugin does not support secret versions");
    return client.listSecretVersions(resource?.resourceTypeId ?? "", decodedResourceId, accountId);
  }, [decodedResourceId, accountId, resource]);

  const handleAccessSecretVersion = useCallback(
    async (versionId: string) => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const r = await accessCloudSecretVersion(
          cloud.orgId,
          cloud.pluginId,
          cloud.resourceTypeId,
          {
            accountId,
            resourceId: decodedResourceId,
            versionId,
            ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
          },
        );
        return r.value;
      }
      const client = clientRef.current;
      if (!client?.accessSecretVersion) throw new Error("Plugin does not support secret versions");
      return client.accessSecretVersion(
        resource?.resourceTypeId ?? "",
        decodedResourceId,
        accountId,
        versionId,
      );
    },
    [decodedResourceId, accountId, resource],
  );

  const handleAddSecretVersion = useCallback(
    async (value: string) => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const r = await addCloudSecretVersion(cloud.orgId, cloud.pluginId, cloud.resourceTypeId, {
          accountId,
          resourceId: decodedResourceId,
          value,
          ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
        });
        dispatchRefreshResource();
        return r.version;
      }
      const client = clientRef.current;
      if (!client?.addSecretVersion) throw new Error("Plugin does not support secret versions");
      const v = await client.addSecretVersion(
        resource?.resourceTypeId ?? "",
        decodedResourceId,
        accountId,
        value,
      );
      dispatchRefreshResource();
      return v;
    },
    [decodedResourceId, accountId, resource],
  );

  const handleModifySecretVersion = useCallback(
    async (versionId: string, action: SecretVersionMutation) => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const r = await modifyCloudSecretVersion(
          cloud.orgId,
          cloud.pluginId,
          cloud.resourceTypeId,
          {
            accountId,
            resourceId: decodedResourceId,
            versionId,
            action,
            ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
          },
        );
        return r.version;
      }
      const client = clientRef.current;
      if (!client?.modifySecretVersion) throw new Error("Plugin does not support secret versions");
      return client.modifySecretVersion(
        resource?.resourceTypeId ?? "",
        decodedResourceId,
        accountId,
        versionId,
        action,
      );
    },
    [decodedResourceId, accountId, resource],
  );

  const handlePeerPaneOpen = useCallback(() => {
    if (peerPanesHydratingRef.current) return;
    const cloud = cloudCtxRef.current;
    if (cloud) {
      peerPanesHydratingRef.current = true;
      void (async () => {
        try {
          const result = (await fetchCloudPeerPanes(
            cloud.orgId,
            cloud.pluginId,
            cloud.resourceTypeId,
            {
              accountId,
              resourceId: decodedResourceId,
              ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
            },
          )) as Array<{
            tabLabel: string;
            pluginLogoSvg: string;
            schema: PeerPaneData["schema"];
            peerPluginId: string;
          }>;
          setPeerPanes(
            result.map((p) => ({
              tabLabel: p.tabLabel,
              pluginLogoSvg: p.pluginLogoSvg,
              credentials: {},
              schema: p.schema,
            })),
          );
        } catch {
          peerPanesHydratingRef.current = false;
        }
      })();
      return;
    }

    const localCtx = localPeerCtxRef.current;
    const client = clientRef.current;
    if (!localCtx || !client) return;
    peerPanesHydratingRef.current = true;
    void (async () => {
      const resolved: PeerPaneData[] = [];
      await Promise.allSettled(
        (localCtx.peerIntegrations ?? []).map(async (integration) => {
          try {
            const peerCredentials: Record<string, string> = {};
            for (const mapping of integration.credentialMappings) {
              const value = await client.resolveOutput(
                localCtx.parentResourceTypeId,
                localCtx.parentResourceId,
                mapping.outputKey,
                accountId,
              );
              peerCredentials[mapping.credentialKey] = value;
            }
            const peerLoaded = await getPlugin(integration.pluginId);
            if (!peerLoaded) return;
            const peerServices = buildPluginHostServices(
              peerLoaded.plugin.manifest,
              peerCredentials,
            );
            const peerClient = peerLoaded.plugin.createClient(peerCredentials, peerServices);
            if (!peerClient.renderPeerPane) return;
            const context: PeerPaneContext = {
              tabLabel: integration.tabLabel,
              parentPluginId: localCtx.parentPluginId,
              parentResourceTypeId: localCtx.parentResourceTypeId,
              parentResourceId: localCtx.parentResourceId,
              accountId,
            };
            const peerSchema = await peerClient.renderPeerPane(context);
            resolved.push({
              tabLabel: integration.tabLabel,
              pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
              credentials: peerCredentials,
              schema: { ...peerSchema, supportsYamlImport: !!peerClient.importYaml },
            });
          } catch (err) {
            const peerLoaded = await getPlugin(integration.pluginId);
            if (!peerLoaded) return;
            const message = err instanceof Error ? err.message : String(err);
            resolved.push({
              tabLabel: integration.tabLabel,
              pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
              credentials: {},
              schema: {
                status: { kind: "status-dot", status: "error", label: message },
                resourceGroups: [],
              },
            });
          }
        }),
      );
      setPeerPanes(resolved);
    })();
  }, [accountId, decodedResourceId]);

  useEffect(() => {
    handlePeerPaneOpenRef.current = handlePeerPaneOpen;
  }, [handlePeerPaneOpen]);

  async function handleDelete() {
    if (!resource || !account) return;
    const cloud = cloudCtxRef.current;
    if (cloud) {
      await deleteCloudResource(
        cloud.orgId,
        cloud.pluginId,
        cloud.resourceTypeId,
        decodedResourceId,
        accountId,
      );
      removeWorkspaceTabs([
        `resource:${accountId}:${decodedResourceId}`,
        `resource:${accountId}:${decodedResourceId}:ssh`,
        `resource:${accountId}:${decodedResourceId}:sftp`,
      ]);
      dispatchResourcesChanged({ accountId, resourceTypeId: cloud.resourceTypeId });
      void navigateToWorkspaceTarget(navigate, accountTabTarget(accountId), {
        label: account.display_name,
      });
      return;
    }
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
    dispatchResourcesChanged({ accountId, resourceTypeId: resource.resourceTypeId });
    void navigateToWorkspaceTarget(navigate, accountTabTarget(accountId), {
      label: account.display_name,
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-muted text-sm animate-pulse">
        Loading…
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
  const noSqlBrowser = schema?.noSqlBrowser;

  function openSshTab() {
    void navigateToWorkspaceTarget(navigate, resourceSshTabTarget(accountId, decodedResourceId), {
      label: resourceTabTitle(resource?.displayName ?? "", "ssh") || "SSH",
      mode: "pin",
    });
  }

  function openSftpTab() {
    void navigateToWorkspaceTarget(navigate, resourceSftpTabTarget(accountId, decodedResourceId), {
      label: resourceTabTitle(resource?.displayName ?? "", "sftp") || "SFTP",
      mode: "pin",
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {isSftpView && (
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {activeCloudOrgId && sshHost && quickSshConnection ? (
              <SftpBrowserPanel
                cloudContext={{
                  orgId: activeCloudOrgId,
                  accountId,
                  resourceId: decodedResourceId,
                  sshHost,
                  sshUsername: quickSshConnection.username,
                  ...(quickSshConnection.keySource.type === "cloud"
                    ? { sshKeyId: quickSshConnection.keySource.sshKeyId }
                    : {}),
                }}
                initialPath="/"
              />
            ) : activeCloudOrgId && !sshHost ? (
              <SftpBrowserPanel
                cloudContext={{
                  orgId: activeCloudOrgId,
                  accountId,
                  resourceId: decodedResourceId,
                }}
                initialPath="/"
              />
            ) : sshConfig ? (
              <SftpBrowserPanel sftpConfig={sshConfig} initialPath="/" />
            ) : sshHost && quickSshConnection ? (
              <SftpBrowserPanel
                sftpConfig={{
                  host: sshHost,
                  port: 22,
                  username: quickSshConnection.username,
                  privateKey: quickSshConnection.privateKey,
                }}
                initialPath="/"
              />
            ) : sshHost ? (
              <SshQuickConnectPanel
                host={sshHost}
                {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
                onConnect={(config) => setQuickSshConnection(config)}
              />
            ) : null}
          </div>
        )}

        {!isSshView && !isSftpView && (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {(hasSshPanel || hasSftpBrowser || resource) && (
              <div className="shrink-0 flex justify-end gap-2 px-4 py-2 border-b border-border bg-surface">
                {hasSftpBrowser && (
                  <button
                    onClick={openSftpTab}
                    className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
                  >
                    Open SFTP tab
                  </button>
                )}
                {hasSshPanel && (
                  <button
                    onClick={openSshTab}
                    className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
                  >
                    Open SSH tab
                  </button>
                )}
                {sshHost && (
                  <>
                    <button
                      onClick={() => setShowTunnelModal(true)}
                      className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
                    >
                      Connect service via SSH
                    </button>
                    <button
                      onClick={() => setShowDockerSetup(true)}
                      className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
                    >
                      Setup Docker
                    </button>
                  </>
                )}
                <button
                  onClick={() => setShowDropSpotlight(true)}
                  className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
                >
                  Connect resource
                </button>
              </div>
            )}
            {
              // overflow-hidden (not overflow-auto) so DetailView fills the
              // available space and its own inner body handles scrolling.
              // Otherwise the outer wrapper scrolls the entire DetailView —
              // header and tab strip included — out of view.
              <div className="flex-1 overflow-hidden min-h-0">
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
                  onPeerPaneOpen={handlePeerPaneOpen}
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
                    const typeDef = childResourceGroups.find((g) => g.typeId === group.typeId);
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
                  {...(hasSqlEditor
                    ? {
                        onRunQuery: handleRunQuery,
                        onExecute: handleExecute,
                        onEstimateQueryCost: handleEstimateQueryCost,
                      }
                    : {})}
                  {...(schema.manifestEditor
                    ? { onGetManifest: handleGetManifest, onApplyManifest: handleApplyManifest }
                    : {})}
                  {...(schema.describe ? { onGetDescribe: handleGetDescribe } : {})}
                  {...(schema.logs ? { onGetLogs: handleGetLogs } : {})}
                  {...(schema.artifactRegistry ? { onListArtifacts: handleListArtifacts } : {})}
                  {...(schema.secretVersions
                    ? {
                        onListSecretVersions: handleListSecretVersions,
                        onAccessSecretVersion: handleAccessSecretVersion,
                        onAddSecretVersion: handleAddSecretVersion,
                        onModifySecretVersion: handleModifySecretVersion,
                      }
                    : {})}
                  {...(resource?.pluginId === "kubernetes" &&
                  resource?.resourceTypeId === "k8s-pod" &&
                  activeCloudOrgId &&
                  cloudCtxRef.current?.parentResourceId
                    ? { onOpenConsole: () => setConsoleOpen(true) }
                    : {})}
                  {...(noSqlBrowser
                    ? {
                        renderNoSqlBrowser: () => {
                          if (noSqlBrowser.driver === "firestore") {
                            return (
                              <FirestoreDocumentBrowser
                                databaseLabel={noSqlBrowser.databaseLabel}
                                connected={true}
                                onCommand={handleNoSqlCommand}
                              />
                            );
                          }
                          return (
                            <FirestoreMongoPeerBrowser
                              resourceId={decodedResourceId}
                              firestoreDatabaseId={noSqlBrowser.databaseLabel}
                            />
                          );
                        },
                      }
                    : {})}
                  metricSeries={metricSeries}
                />
              </div>
            }
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
                keySource={quickSshConnection.keySource}
                accountId={accountId}
                resourceId={decodedResourceId}
              />
            ) : sshHost ? (
              <SshQuickConnectPanel
                host={sshHost}
                {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
                onConnect={(config) => setQuickSshConnection(config)}
              />
            ) : null}
          </div>
        )}
      </div>

      {/* SSH bottom bar — connection info + disconnect */}
      {isSshView && (hasTerminal || quickSshConnection) && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-t border-border bg-surface">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          <span className="text-xs font-mono text-on-surface-tertiary">
            {sshConfig
              ? `${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`
              : quickSshConnection && sshHost
                ? `${quickSshConnection.username}@${sshHost}:22`
                : null}
          </span>
          {quickSshConnection && (
            <button
              onClick={() => setQuickSshConnection(null)}
              className="ml-auto text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
            >
              Disconnect ✕
            </button>
          )}
        </div>
      )}

      {/* Non-SSH bottom panels — hidden when in SSH view */}
      {!isSshView && !isSftpView && (canDelete || credentialFormats.length > 0) && (
        <div className="shrink-0 px-4 py-2 border-t border-border flex items-center justify-end gap-3">
          {credentialFormats.length > 0 && (
            <button
              onClick={() => setShowExportCredential(true)}
              className="text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
            >
              Get credentials…
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-on-surface-faint hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
            >
              Delete {resourceTypeLabel}…
            </button>
          )}
        </div>
      )}

      {showExportCredential && resource && credentialFormats.length > 0 && (
        <CredentialExportModal
          resourceDisplayName={resource.displayName}
          formats={credentialFormats}
          generate={async (formatId) => {
            const local = clientRef.current;
            if (local?.exportCredential) {
              return local.exportCredential(
                resource.resourceTypeId,
                resource.id,
                accountId,
                formatId,
              );
            }
            const cloud = cloudCtxRef.current;
            if (cloud) {
              const result = (await exportCloudCredential(
                cloud.orgId,
                cloud.pluginId,
                resource.resourceTypeId,
                resource.id,
                accountId,
                formatId,
                cloud.parentResourceId,
              )) as Awaited<ReturnType<NonNullable<PluginClient["exportCredential"]>>>;
              return result;
            }
            throw new Error("No client available for credential export");
          }}
          onClose={() => setShowExportCredential(false)}
        />
      )}

      {confirmDelete && resource && (
        <ConfirmDeleteModal
          kind={resourceTypeLabel}
          name={resource.displayName}
          onConfirm={() => handleDelete()}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      {promptModal && (
        <PromptNoSqlCommandModal
          title={promptModal.title ?? promptModal.command}
          {...(promptModal.description ? { description: promptModal.description } : {})}
          fields={promptModal.fields}
          submitLabel={promptModal.submitLabel ?? "Submit"}
          danger={!!promptModal.danger}
          resourcePickerProps={{ loadResources: loadPromptResources, accountId }}
          onCancel={() => setPromptModal(null)}
          onSubmit={async (values) => {
            // Pass the form values as a single JSON-encoded arg so plugins
            // can read by field key regardless of order or showWhen-hidden
            // fields.
            await handleNoSqlCommand(promptModal.command, [JSON.stringify(values)]);
            setPromptModal(null);
            dispatchRefreshResource();
          }}
        />
      )}

      {!isSshView && !isSftpView && !hasSqlEditor && pgError && (
        <div className="shrink-0 px-4 py-2 border-t border-border bg-surface">
          <span className="text-xs text-red-400 font-mono">SQL connection failed: {pgError}</span>
        </div>
      )}

      {!isSshView &&
        !isSftpView &&
        !activeCloudOrgId &&
        isKvPlugin &&
        kvDriverName === "mongodb" &&
        resource && (
          <MongoDocumentBrowser
            connectionString={connectionStringRef.current}
            databaseName={String(resource.fields["database"] ?? "test")}
            connected={kvConnected}
          />
        )}

      {!isSshView &&
        !isSftpView &&
        !activeCloudOrgId &&
        isKvPlugin &&
        kvDriverName !== "mongodb" && (
          <KvConsole
            mode="local"
            connectionString={connectionStringRef.current}
            driverName={kvDriverName ?? "redis"}
            connected={kvConnected}
          />
        )}

      {!isSshView &&
        !isSftpView &&
        activeCloudOrgId &&
        isKvPlugin &&
        kvDriverName !== "mongodb" && (
          <KvConsole
            mode="cloud"
            orgId={activeCloudOrgId}
            accountId={accountId}
            {...(peerPlugin ? { pluginId: peerPlugin } : {})}
            {...(peerParent ? { parentResourceId: peerParent } : {})}
            driverName={kvDriverName ?? "redis"}
            connected={kvConnected}
          />
        )}

      {!isSshView && !isSftpView && !activeCloudOrgId && isDockerPlugin && resource && (
        <DockerActionsPanel
          containerId={String(resource.resolvedOutputs["containerId"] ?? resource.externalId ?? "")}
          driverId={dockerDriverName ?? "docker"}
          dockerHost={dockerHostRef.current}
        />
      )}

      {!isSshView && !isSftpView && hasStorageBrowser && (
        <FileBrowser
          formatError={formatErrorMessage}
          bucketName={schema.storageBrowser!.bucketName}
          onList={(prefix) =>
            clientRef.current!.listStorageObjects!(schema.storageBrowser!.bucketName, prefix)
          }
          onUpload={(bucket, key, file, onProgress) =>
            clientRef.current!.uploadStorageObject!(bucket, key, file, onProgress)
          }
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
          {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
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
          {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
          sourceAccountId={accountId}
          onClose={() => setShowDockerSetup(false)}
          onComplete={(newAccountId) => {
            setShowDockerSetup(false);
            void navigateToWorkspaceTarget(navigate, accountTabTarget(newAccountId));
          }}
        />
      )}

      {showDropSpotlight && resource && (
        <SpotlightSearch
          mode="drop"
          onClose={() => setShowDropSpotlight(false)}
          onDrop={(source) => {
            setShowDropSpotlight(false);
            window.dispatchEvent(
              new CustomEvent("iw:sidebar-secret-drop", {
                detail: { source, targetId: decodedResourceId, kind: "resource" },
              }),
            );
          }}
        />
      )}

      {createChildTarget && account && (
        <CreateResourceModal
          accountId={accountId}
          pluginId={account.plugin_id}
          resourceType={createChildTarget}
          parentResourceId={decodedResourceId}
          onClose={() => setCreateChildTarget(null)}
          onCreated={(newResource) => {
            const childTypeId = createChildTarget.id;
            setCreateChildTarget(null);
            dispatchResourcesChanged({ accountId, resourceTypeId: childTypeId });
            void navigateToWorkspaceTarget(
              navigate,
              resourceTabTarget(accountId, newResource.id, account.plugin_id, childTypeId),
              { label: newResource.displayName },
            );
          }}
        />
      )}

      {consoleOpen && resource && activeCloudOrgId && cloudCtxRef.current?.parentResourceId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConsoleOpen(false);
          }}
        >
          <div className="w-[min(1100px,92vw)] h-[min(720px,82vh)] overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-on-surface">
                Console — {resource.displayName}
              </h2>
              <button
                type="button"
                onClick={() => setConsoleOpen(false)}
                className="text-on-surface-muted hover:text-on-surface-secondary text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <K8sExecPanel
                cloudContext={{
                  orgId: activeCloudOrgId,
                  accountId,
                  resourceId: cloudCtxRef.current.parentResourceId,
                  peerPluginId: resource.pluginId,
                }}
                namespace={String(resource.fields["namespace"] ?? "default")}
                podName={resource.displayName}
                {...(typeof resource.fields["containerName"] === "string" &&
                resource.fields["containerName"]
                  ? { containerName: String(resource.fields["containerName"]) }
                  : {})}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
