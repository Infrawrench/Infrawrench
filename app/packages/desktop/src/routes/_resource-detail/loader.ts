import { z } from "zod";
import type {
  CredentialFormat,
  DetailViewSchema,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import { metricSeriesSchema } from "@infrawrench/plugin-base";
import {
  buildChildResourceGroups,
  formatErrorMessage,
  resourceTabTitle,
  toast,
  useUIStore,
  type ChildResource,
  type ChildResourceGroup,
  type PeerPaneData,
} from "@infrawrench/ui";
import {
  getCloudAccountDetail,
  getCloudResourceDetail,
  listCloudAccountResources,
  syncCloudAccountType,
  fetchCloudMetrics,
} from "../../lib/cloud-api";
import { getDb } from "../../db/client";
import type { AccountRow } from "../../db/rows";
import { invoke } from "../../lib/invoke";
import { getPlugin } from "../../plugins/loader";
import { getSqlSession, setSqlSession } from "../../lib/sql-session";
import {
  buildDockerHostServices,
  buildHostServices,
  buildKvHostServices,
  buildPluginHostServices,
  sqlQuery,
} from "../../lib/sql-drivers";
import { resolveTunneledHost } from "../../lib/ssh-tunnel";
import type { CloudCtx, SqliteResourceRow, SshConfig } from "./types";

export interface LoaderRefs {
  connectionString: { current: string };
  sqlDriverId: { current: string };
  client: { current: PluginClient | null };
  cloudCtx: { current: CloudCtx | null };
  dockerHost: { current: string };
  localPeerCtx: {
    current: {
      peerIntegrations: ResourceTypeDefinition["peerIntegrations"];
      parentPluginId: string;
      parentResourceTypeId: string;
      parentResourceId: string;
    } | null;
  };
}

export interface LoaderSetters {
  setAccount: (a: AccountRow | null) => void;
  setResource: (r: ResourceInstance | null) => void;
  setSchema: (s: DetailViewSchema | null) => void;
  setLogoSvg: (s: string) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setPgConnected: (b: boolean) => void;
  setPgError: (e: string | null) => void;
  setKvConnected: (b: boolean) => void;
  setIsKvPlugin: (b: boolean) => void;
  setKvDriverName: (s: string | null) => void;
  setIsDockerPlugin: (b: boolean) => void;
  setDockerDriverName: (s: string | null) => void;
  setHasStorageToken: (b: boolean) => void;
  setSshConfig: (c: SshConfig | null) => void;
  setSshHost: (s: string | null) => void;
  setSshDefaultUsername: (s: string | null) => void;
  setCanDelete: (b: boolean) => void;
  setCredentialFormats: (f: CredentialFormat[]) => void;
  setResourceTypeLabel: (s: string) => void;
  setPeerPanes: (v: PeerPaneData[] | ((prev: PeerPaneData[]) => PeerPaneData[])) => void;
  setChildResourceGroups: (g: ChildResourceGroup[]) => void;
  setMetricSeries: (m: MetricSeries[] | undefined) => void;
}

export interface LoaderParams {
  accountId: string;
  decodedResourceId: string;
  peerPlugin: string | undefined;
  peerType: string | undefined;
  peerParent: string | undefined;
  locationHash: string;
  isBackground: boolean;
  isCancelled: () => boolean;
  refs: LoaderRefs;
  setters: LoaderSetters;
  setAccountConnected: (accountId: string, connected: boolean) => void;
}

export async function loadCloudResource(orgId: string, params: LoaderParams): Promise<void> {
  const {
    accountId,
    decodedResourceId,
    peerPlugin,
    peerType,
    peerParent,
    locationHash,
    isBackground,
    isCancelled,
    refs,
    setters,
    setAccountConnected,
  } = params;

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

  if (isCancelled()) return;

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

  refs.cloudCtx.current = {
    orgId,
    pluginId,
    resourceTypeId,
    ...(peerParent ? { parentResourceId: peerParent } : {}),
  };
  refs.client.current = null;

  // Storage requires a local client until cloud storage endpoints land.
  const { storageBrowser: _storageBrowser, ...restSchema } = detail.detailSchema;
  void _storageBrowser;

  setters.setAccount({
    id: accountId,
    plugin_id: pluginId,
    display_name: accountDetail.account.displayName,
    encrypted_credentials: "",
    credentials_iv: "",
  });
  setters.setLogoSvg(detail.pluginLogoSvg);
  setters.setResource(cloudResource);
  setters.setResourceTypeLabel(detail.resourceTypeLabel);
  setters.setSchema(restSchema);
  setters.setCanDelete(detail.canDelete);
  setters.setCredentialFormats(detail.credentialFormats ?? []);
  setters.setSshHost(detail.sshHost);
  setters.setSshDefaultUsername(detail.defaultSshUsername);
  setters.setPgConnected(detail.hasSqlEditor);
  setters.setIsKvPlugin(detail.hasKvConsole);
  setters.setKvDriverName(detail.kvDriverName ?? null);
  setters.setKvConnected(detail.hasKvConsole);
  setters.setIsDockerPlugin(detail.hasDockerActions);
  setters.setDockerDriverName(null);
  setters.setChildResourceGroups(
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

  // Stubs on first load; hydrate lazily on tab open. Preserve hydrated panes
  // across background refreshes.
  const stubs = detail.peerIntegrationStubs ?? [];
  const eagerPanes = detail.peerPanes ?? [];
  if (eagerPanes.length > 0) {
    setters.setPeerPanes(
      eagerPanes.map((p) => ({
        tabLabel: p.tabLabel,
        pluginLogoSvg: p.pluginLogoSvg,
        credentials: {},
        schema: p.schema,
      })),
    );
  } else if (isBackground) {
    setters.setPeerPanes((prev) => {
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
    setters.setPeerPanes(
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
        if (!isCancelled())
          setters.setMetricSeries(z.array(metricSeriesSchema).parse(series) as MetricSeries[]);
      })
      .catch((err) => {
        if (!isCancelled()) toast.error(`Couldn't load metrics: ${formatErrorMessage(err)}`);
      });
  }
}

export async function loadLocalPeerResource(params: LoaderParams): Promise<void> {
  const {
    accountId,
    decodedResourceId,
    peerPlugin,
    peerType,
    peerParent,
    locationHash,
    isCancelled,
    refs,
    setters,
    setAccountConnected,
  } = params;

  const db = await getDb();
  const accountRows = await db.select<AccountRow[]>(
    "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
    [accountId],
  );
  const accountRow = accountRows[0];
  if (!accountRow) throw new Error("Account not found");

  const parentCredentials = await invoke<Record<string, string>>("account_get_credentials", {
    accountId: accountRow.id,
  });

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
  refs.client.current = peerClient;

  const peerResources = await peerClient.listResources(peerType!, accountId);
  const found = peerResources.find((r) => r.id === decodedResourceId);
  if (!found) throw new Error("Resource not found");

  if (isCancelled()) return;

  const peerTypeDef = peerLoaded.plugin.resourceTypes.find((t) => t.id === peerType);
  const detailSchema = peerClient.renderDetail(found);

  const peerKvDriver = peerLoaded.plugin.manifest.kvDriver;
  const peerKvConnectionString = peerKvDriver
    ? (peerCredentials[peerKvDriver.credentialKey] ?? "")
    : "";
  refs.connectionString.current = peerKvConnectionString;

  setters.setAccount(accountRow);
  setters.setLogoSvg(peerLoaded.plugin.manifest.logoSvg);
  setters.setResource(found);
  setters.setResourceTypeLabel(peerTypeDef?.displayName ?? "Resource");
  setters.setSchema(detailSchema);
  setters.setCanDelete(!!peerClient.deleteResource);
  setters.setSshHost(null);
  setters.setSshDefaultUsername(null);
  setters.setPgConnected(false);
  setters.setIsKvPlugin(!!peerKvDriver);
  setters.setKvDriverName(peerKvDriver?.driver ?? null);
  setters.setKvConnected(!!peerKvConnectionString);
  setters.setIsDockerPlugin(false);
  setters.setDockerDriverName(null);
  setters.setChildResourceGroups([]);
  setters.setPeerPanes([]);
  refs.localPeerCtx.current = null;
  setAccountConnected(accountId, true);

  const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
  if (activeWorkspaceTabId) {
    const viewSuffix = resourceTabTitle(found.displayName, locationHash);
    setWorkspaceTabTitle(activeWorkspaceTabId, viewSuffix);
  }
}

export async function loadLocalResource(params: LoaderParams): Promise<void> {
  const {
    accountId,
    decodedResourceId,
    locationHash,
    isBackground,
    isCancelled,
    refs,
    setters,
    setAccountConnected,
  } = params;

  const db = await getDb();
  const session = getSqlSession(accountId);

  // Cached connection + SQLite hit: render immediately without waiting for
  // listResources or pg queries.
  if (session) {
    refs.connectionString.current = session.connectionString;

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
      if (loaded && !isCancelled()) {
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
        setters.setAccount(accountRow);
        setters.setLogoSvg(loaded.plugin.manifest.logoSvg);
        setters.setResource(immediateResource);
        setters.setResourceTypeLabel(fastTypeDef?.displayName ?? "Resource");
        setters.setSchema(immediateSchema);
        setters.setPgConnected(!!session.tablesJson);
        setAccountConnected(accountId, true);
        setters.setLoading(false);
      }
    }
  } else if (!isBackground) {
    setters.setLoading(true);
  }

  const accountRows = await db.select<AccountRow[]>(
    "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
    [accountId],
  );
  const accountRow = accountRows[0];
  if (!accountRow) throw new Error("Account not found");
  if (!isCancelled()) setters.setAccount(accountRow);

  const credentials = await invoke<Record<string, string>>("account_get_credentials", {
    accountId: accountRow.id,
  });

  const loaded = await getPlugin(accountRow.plugin_id);
  if (!loaded) throw new Error(`Plugin "${accountRow.plugin_id}" not loaded`);
  const { plugin } = loaded;
  if (!isCancelled()) setters.setLogoSvg(plugin.manifest.logoSvg);

  const sqlDriverDecl = loaded.plugin.manifest.sqlDriver;
  const kvDriverDecl = loaded.plugin.manifest.kvDriver;
  const dockerDriverDecl = loaded.plugin.manifest.dockerDriver;
  const isKv = !sqlDriverDecl && !!kvDriverDecl;
  const isDocker = !sqlDriverDecl && !kvDriverDecl && !!dockerDriverDecl;
  if (!isCancelled()) {
    setters.setIsKvPlugin(isKv);
    setters.setKvDriverName(kvDriverDecl?.driver ?? null);
    setters.setIsDockerPlugin(isDocker);
    setters.setDockerDriverName(dockerDriverDecl?.driver ?? null);
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
    refs.dockerHost.current = effectiveCs;
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
    refs.connectionString.current = cs;
    refs.sqlDriverId.current = sqlDriverDecl?.driver ?? kvDriverDecl?.driver ?? "";
  }

  const client = plugin.createClient(credentials, hostServices);
  refs.client.current = client;
  const resourceTypeId = decodedResourceId.split(":")[1] ?? "pg-database";
  const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === resourceTypeId);
  if (!isCancelled()) {
    setters.setHasStorageToken(!!client.getStorageAccessToken);
    setters.setCanDelete(!!client.deleteResource);
    setters.setCredentialFormats(
      client.exportCredential && resourceTypeDef?.credentialFormats
        ? resourceTypeDef.credentialFormats
        : [],
    );
    setters.setSshConfig(client.getSshConfig ? client.getSshConfig() : null);
  }
  const resources = await client.listResources(resourceTypeId, accountId);
  const foundResource = resources.find((r) => r.id === decodedResourceId) ?? resources[0];
  if (!foundResource) throw new Error("Resource not found");

  let enrichedResource: ResourceInstance = foundResource;
  let sqlOk = !!session;

  if (hostServices && isDocker) {
    try {
      await client.fetchStats?.();
      if (!isCancelled()) setAccountConnected(accountId, true);
      sqlOk = true;
    } catch {
      /* ignore */
    }
  } else if (hostServices && cs && isKv) {
    try {
      await client.fetchStats?.();
      if (!isCancelled()) {
        setters.setKvConnected(true);
        setAccountConnected(accountId, true);
      }
      sqlOk = true;
    } catch {
      /* ignore — console will show the error on first command */
    }
  } else if (client.executeQuery) {
    // REST-based query providers (e.g. BigQuery) — no node SQL driver needed.
    try {
      const tables = (await client.introspectResource?.(decodedResourceId, accountId)) ?? [];
      const tablesJson = JSON.stringify(tables);
      enrichedResource = {
        ...foundResource,
        resolvedOutputs: { ...foundResource.resolvedOutputs, __tables__: tablesJson },
      };
      sqlOk = true;
      if (!isCancelled()) {
        setters.setPgConnected(true);
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
      if (!isCancelled()) {
        setters.setPgConnected(true);
        setAccountConnected(accountId, true);
      }
    } catch (err) {
      if (!isCancelled() && !session) setters.setPgError(String(err));
    }
  }

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
        refs.connectionString.current = rtConnectionString;
        refs.sqlDriverId.current = rtSqlDriver.driver;

        // Expose the resolved string so renderDetail can show it without async work.
        enrichedResource = {
          ...enrichedResource,
          resolvedOutputs: {
            ...enrichedResource.resolvedOutputs,
            [rtSqlDriver.connectionStringOutputKey]: rtConnectionString,
          },
        };

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
          if (!isCancelled()) {
            setters.setPgConnected(true);
            setAccountConnected(accountId, true);
          }
        } catch {
          // Introspection failed — still enable SQL editor without table metadata
          sqlOk = true;
          if (!isCancelled()) {
            setters.setPgConnected(true);
            setAccountConnected(accountId, true);
          }
        }
      }
    } catch (err) {
      if (!isCancelled() && !session) setters.setPgError(String(err));
    }
  }

  if (!isCancelled()) {
    if (client.enrichDetail) {
      try {
        enrichedResource = await client.enrichDetail(enrichedResource);
      } catch {
        /* enrichment is best-effort */
      }
    }
    const detailSchema = client.renderDetail(enrichedResource);

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

    setters.setSchema(finalSchema);
    setters.setResource(enrichedResource);

    const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
    if (activeWorkspaceTabId) {
      const viewSuffix = resourceTabTitle(enrichedResource.displayName, locationHash);
      setWorkspaceTabTitle(activeWorkspaceTabId, viewSuffix);
    }

    setters.setResourceTypeLabel(resourceTypeDef?.displayName ?? "Resource");
    if (resourceTypeDef?.sshEndpoint) {
      const { hostOutputKey, runningWhen, usernameFieldKey, defaultUsername } =
        resourceTypeDef.sshEndpoint;
      if (runningWhen) {
        const fieldVal = String(enrichedResource.fields[runningWhen.fieldKey] ?? "");
        if (fieldVal.toLowerCase() !== runningWhen.value.toLowerCase()) {
          if (!isCancelled()) setters.setSshHost(null);
        } else {
          const host = String(
            enrichedResource.resolvedOutputs[hostOutputKey] ??
              enrichedResource.fields[hostOutputKey] ??
              "",
          );
          if (!isCancelled()) setters.setSshHost(host || null);
        }
      } else {
        const host = String(
          enrichedResource.resolvedOutputs[hostOutputKey] ??
            enrichedResource.fields[hostOutputKey] ??
            "",
        );
        if (!isCancelled()) setters.setSshHost(host || null);
      }
      if (!isCancelled()) {
        let resolvedUsername: string | null = null;
        if (usernameFieldKey) {
          const val = String(enrichedResource.fields[usernameFieldKey] ?? "");
          if (val) resolvedUsername = val;
        }
        if (!resolvedUsername && defaultUsername) resolvedUsername = defaultUsername;
        setters.setSshDefaultUsername(resolvedUsername);
      }
    } else if (!isCancelled()) {
      setters.setSshHost(null);
      setters.setSshDefaultUsername(null);
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
      if (!isCancelled()) {
        setters.setChildResourceGroups(
          buildChildResourceGroups(childTypes, allChildResources) as ChildResourceGroup[],
        );
      }
    } else if (!isCancelled()) {
      setters.setChildResourceGroups([]);
    }

    // Stubs so tabs render immediately; handlePeerPaneOpen hydrates on click.
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
      refs.localPeerCtx.current = {
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
      if (!isCancelled()) {
        if (isBackground) {
          setters.setPeerPanes((prev) => (prev.length > 0 ? prev : stubPanes));
        } else {
          setters.setPeerPanes(stubPanes);
        }
      }
    } else {
      refs.localPeerCtx.current = null;
      if (!isCancelled() && !isBackground) setters.setPeerPanes([]);
    }

    if (resourceTypeDef?.supportsMetrics && client.fetchMetricSeries && !isBackground) {
      client
        .fetchMetricSeries(enrichedResource.resourceTypeId, enrichedResource.id, accountId)
        .then((series) => {
          if (!isCancelled()) setters.setMetricSeries(series);
        })
        .catch((err) => {
          if (!isCancelled()) toast.error(`Couldn't load metrics: ${formatErrorMessage(err)}`);
        });
    }
  }
}
