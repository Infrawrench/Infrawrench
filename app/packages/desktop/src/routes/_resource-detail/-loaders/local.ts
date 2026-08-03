import type {
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
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
import { getDb } from "../../../db/client";
import type { AccountRow } from "../../../db/rows";
import { invoke } from "../../../lib/invoke";
import { getPlugin } from "../../../plugins/loader";
import { getSqlSession, setSqlSession } from "../../../lib/sql-session";
import {
  buildDockerHostServices,
  buildHostServices,
  buildKvHostServices,
  buildPluginHostServices,
  secretHostServices,
  sqlQuery,
} from "../../../lib/sql-drivers";
import { resolveTunneledHost } from "../../../lib/ssh-tunnel";
import type { SqliteResourceRow } from "../-types";
import type { LoaderParams } from "./types";

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
    tabId,
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

  const driverHostServices =
    sqlDriverDecl && cs
      ? buildHostServices(sqlDriverDecl.driver, cs)
      : kvDriverDecl && cs
        ? buildKvHostServices(kvDriverDecl.driver, cs)
        : dockerDriverDecl && effectiveCs
          ? buildDockerHostServices(dockerDriverDecl.driver, effectiveCs)
          : undefined;
  // Always include the secret host service so plugins can persist/read their
  // own secret-field state (e.g. DigitalOcean minting a managed-DB connection
  // user). Driver-specific services (sql/kv/docker) merge on top when present.
  const hostServices: HostServices = { ...(driverHostServices ?? {}), secrets: secretHostServices };

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
    const canEdit = !!client.updateResource && !!resourceTypeDef?.supportsUpdate;
    setters.setCanEdit(canEdit);
    setters.setEditableFields(canEdit ? (resourceTypeDef?.fields ?? []) : []);
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
            ).flatMap((c) =>
              c.table_name === t.table_name ? [{ name: c.column_name, type: c.data_type }] : [],
            );
            const pks = (pkRows as Array<{ table_name: string; column_name: string }>).flatMap(
              (p) => (p.table_name === t.table_name ? [p.column_name] : []),
            );
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

    if (tabId) {
      const viewSuffix = resourceTabTitle(enrichedResource.displayName, locationHash);
      useUIStore.getState().setWorkspaceTabTitle(tabId, viewSuffix);
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

    if (resourceTypeDef?.rdpEndpoint) {
      const { hostOutputKey, runningWhen, windowsWhen, usernameFieldKey, defaultUsername } =
        resourceTypeDef.rdpEndpoint;
      const gatePasses = (guard?: { fieldKey: string; value: string }): boolean => {
        if (!guard) return true;
        const fieldVal = String(enrichedResource.fields[guard.fieldKey] ?? "");
        return fieldVal.toLowerCase() === guard.value.toLowerCase();
      };
      if (!gatePasses(runningWhen) || !gatePasses(windowsWhen)) {
        if (!isCancelled()) setters.setRdpHost(null);
      } else {
        const host = String(
          enrichedResource.resolvedOutputs[hostOutputKey] ??
            enrichedResource.fields[hostOutputKey] ??
            "",
        );
        if (!isCancelled()) setters.setRdpHost(host || null);
      }
      if (!isCancelled()) {
        let resolvedUsername: string | null = null;
        if (usernameFieldKey) {
          const val = String(enrichedResource.fields[usernameFieldKey] ?? "");
          if (val) resolvedUsername = val;
        }
        if (!resolvedUsername && defaultUsername) resolvedUsername = defaultUsername;
        setters.setRdpDefaultUsername(resolvedUsername);
      }
    } else if (!isCancelled()) {
      setters.setRdpHost(null);
      setters.setRdpDefaultUsername(null);
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
                fields: r.fields ?? {},
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
        if (i.requiresFields) {
          for (const key of i.requiresFields) {
            const v = integrationFields[key];
            if (v == null || v === "") return false;
          }
        }
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
        parentResourceFields: enrichedResource.fields,
        parentResourceOutputs: enrichedResource.resolvedOutputs,
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

    const peerMetricIntegrations = (resourceTypeDef?.peerIntegrations ?? []).filter(
      (i) => i.exposeMetricsToParent,
    );
    const wantsOwnMetrics = !!resourceTypeDef?.supportsMetrics && !!client.fetchMetricSeries;
    if ((wantsOwnMetrics || peerMetricIntegrations.length > 0) && !isBackground) {
      Promise.all([
        wantsOwnMetrics
          ? client.fetchMetricSeries!(
              enrichedResource.resourceTypeId,
              enrichedResource.id,
              accountId,
            )
          : Promise.resolve<MetricSeries[]>([]),
        peerMetricIntegrations.length > 0
          ? fetchLocalPeerMetrics(
              client,
              peerMetricIntegrations,
              enrichedResource,
              accountId,
            ).catch(() => [] as MetricSeries[])
          : Promise.resolve<MetricSeries[]>([]),
      ])
        .then(([own, peer]) => {
          if (!isCancelled()) setters.setMetricSeries([...own, ...peer]);
        })
        .catch((err) => {
          if (!isCancelled()) toast.error(`Couldn't load metrics: ${formatErrorMessage(err)}`);
        });
    }
  }
}

async function fetchLocalPeerMetrics(
  parentClient: PluginClient,
  integrations: NonNullable<ResourceTypeDefinition["peerIntegrations"]>,
  parentResource: ResourceInstance,
  accountId: string,
): Promise<MetricSeries[]> {
  const results = await Promise.allSettled(
    integrations.map(async (integration) => {
      const peerCreds: Record<string, string> = {};
      for (const mapping of integration.credentialMappings) {
        peerCreds[mapping.credentialKey] = await parentClient.resolveOutput(
          parentResource.resourceTypeId,
          parentResource.id,
          mapping.outputKey,
          accountId,
        );
      }
      const peerLoaded = await getPlugin(integration.pluginId);
      if (!peerLoaded) return [];
      const peerHostServices = buildPluginHostServices(peerLoaded.plugin.manifest, peerCreds);
      const peerClient = peerLoaded.plugin.createClient(peerCreds, peerHostServices);
      if (!peerClient.fetchMetricSeries) return [];
      const series = await peerClient.fetchMetricSeries(
        parentResource.resourceTypeId,
        parentResource.id,
        accountId,
      );
      return series.map((s) => ({ ...s, label: `${integration.tabLabel} · ${s.label}` }));
    }),
  );
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
