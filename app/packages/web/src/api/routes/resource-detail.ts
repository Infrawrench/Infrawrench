import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { resources } from "../../db/schema";
import { getPlugin } from "../../plugins/loader";
import { sqlDrivers } from "../../services/drivers";
import {
  getClientForAccount,
  getClientForResource,
  buildPeerPanes,
  filterVisiblePeerIntegrations,
} from "../../services/plugin-clients";
import { loadSecretStatesForResource } from "../../services/secret-states";
import type { ResourceInstance, DetailViewSchema, PeerPaneSchema } from "@infrawrench/plugin-base";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";
import { registerManifestRoutes } from "./resource-detail/manifests";
import { registerSecretVersionRoutes } from "./resource-detail/secret-versions";
import { registerLifecycleRoutes } from "./resource-detail/lifecycle";
import { registerActionRoutes } from "./resource-detail/actions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/resources/:pluginId/:typeId/detail?resourceId=...&parentResourceId=... — full resource detail payload */
app.get("/:pluginId/:typeId/detail", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const resourceId = c.req.query("resourceId");
  const parentResourceId = c.req.query("parentResourceId");
  // When false, skip the expensive peerPane fetch and return only stubs.
  // The frontend lazy-fetches via POST /peer-panes when a peer tab is opened.
  const includePeerPanes = c.req.query("includePeerPanes") !== "false";
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);

  const [dbResource] = parentResourceId
    ? [undefined]
    : await db
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.id, resourceId),
            eq(resources.organizationId, organizationId),
            eq(resources.pluginId, pluginId),
            eq(resources.resourceTypeId, resourceTypeId),
            isNull(resources.deletedAt),
          ),
        )
        .limit(1);

  const loadedPlugin = await getPlugin(pluginId);
  if (!loadedPlugin) return c.json({ error: "Plugin not found" }, 404);

  const accountId = dbResource?.accountId ?? c.req.query("accountId") ?? resourceId.split(":")[0];
  if (!accountId) return c.json({ error: "Cannot resolve account" }, 404);

  const ctx = parentResourceId
    ? await getClientForResource(pluginId, accountId, organizationId, parentResourceId)
    : await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  const { client, plugin, account } = ctx;

  // Build the ResourceInstance — always fetch live data from the provider
  // (like desktop does) so status changes (e.g. provisioning → running)
  // are reflected immediately.
  let instance: ResourceInstance;

  let liveResources: ResourceInstance[] = [];
  let liveFetchOk = false;
  try {
    liveResources = await client.listResources(resourceTypeId, accountId);
    liveFetchOk = true;
  } catch (err) {
    // Provider API failed — fall back to DB data. Log so dev sees provider regressions.
    console.error(
      `[resource-detail] Provider listResources failed for ${pluginId}/${resourceTypeId}:`,
      err,
    );
  }
  const liveInstance = liveResources.find((r) => r.id === resourceId);

  if (liveInstance) {
    // Overlay any DB-persisted secretStates (decrypted to plaintext) onto the
    // live instance — listers don't return create-time secrets like passwords.
    const persistedSecrets = parentResourceId ? [] : await loadSecretStatesForResource(resourceId);
    const liveSecretKeys = new Set(liveInstance.secretStates.map((s) => s.fieldKey));
    instance = {
      ...liveInstance,
      secretStates: [
        ...liveInstance.secretStates,
        ...persistedSecrets.filter((s) => !liveSecretKeys.has(s.fieldKey)),
      ],
    };
    if (!parentResourceId) {
      // Peer resources aren't persisted in the DB; skip the upsert for them.
      db.insert(resources)
        .values({
          id: liveInstance.id,
          organizationId,
          pluginId: liveInstance.pluginId,
          resourceTypeId: liveInstance.resourceTypeId,
          accountId,
          displayName: liveInstance.displayName,
          externalId: liveInstance.externalId ?? null,
          fieldsJson: liveInstance.fields ?? {},
          outputsJson: liveInstance.resolvedOutputs ?? {},
          parentResourceId: liveInstance.parentResourceId ?? null,
          lastSyncedAt: new Date(),
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: resources.id,
          set: {
            displayName: liveInstance.displayName,
            fieldsJson: liveInstance.fields ?? {},
            outputsJson: liveInstance.resolvedOutputs ?? {},
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
        })
        .catch((e) => console.error("[resource-detail] Failed to upsert:", e));
    }
  } else if (liveFetchOk && dbResource?.lastSyncedAt) {
    // Provider listed resources successfully but this one wasn't included,
    // and it was previously synced — it's been deleted externally.
    db.update(resources)
      .set({ deletedAt: new Date() })
      .where(eq(resources.id, resourceId))
      .catch((e) => console.error("[resource-detail] Failed to soft-delete:", e));
    return c.json({ error: "Resource not found" }, 404);
  } else if (dbResource) {
    // Provider API failed OR resource was never synced (just created) — use DB data
    instance = {
      id: dbResource.id,
      pluginId: dbResource.pluginId,
      resourceTypeId: dbResource.resourceTypeId,
      accountId: dbResource.accountId,
      displayName: dbResource.displayName,
      fields: (dbResource.fieldsJson as Record<string, string | number | boolean>) ?? {},
      resolvedOutputs: (dbResource.outputsJson as Record<string, string>) ?? {},
      secretStates: await loadSecretStatesForResource(resourceId),
      ...(dbResource.externalId != null && { externalId: dbResource.externalId }),
      ...(dbResource.parentResourceId != null && { parentResourceId: dbResource.parentResourceId }),
      createdAt: dbResource.createdAt.toISOString(),
      updatedAt: dbResource.updatedAt.toISOString(),
      ...(dbResource.lastSyncedAt != null && {
        lastSyncedAt: dbResource.lastSyncedAt.toISOString(),
      }),
    };
  } else {
    return c.json({ error: "Resource not found" }, 404);
  }

  const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === resourceTypeId);

  let sqlOk = false;
  let enrichedInstance = instance;
  const manifest = plugin.manifest;

  if (manifest.sqlDriver || client.executeQuery) {
    try {
      const tables =
        (await client.introspectResource?.(resourceId, accountId)) ??
        (await client.introspect?.()) ??
        [];
      enrichedInstance = {
        ...enrichedInstance,
        resolvedOutputs: {
          ...enrichedInstance.resolvedOutputs,
          __tables__: JSON.stringify(tables),
        },
      };
      sqlOk = true;
    } catch {
      /* introspection is non-critical */
    }
  }

  const rtSqlDriver = resourceTypeDef?.resourceSqlDriver;
  if (rtSqlDriver && !sqlOk) {
    try {
      const rtConnectionString = await client.resolveOutput(
        resourceTypeId,
        resourceId,
        rtSqlDriver.connectionStringOutputKey,
        accountId,
      );
      if (rtConnectionString) {
        // Expose the resolved connection string to renderDetail so plugins can
        // display it (instead of a placeholder) without doing async work themselves.
        enrichedInstance = {
          ...enrichedInstance,
          resolvedOutputs: {
            ...enrichedInstance.resolvedOutputs,
            [rtSqlDriver.connectionStringOutputKey]: rtConnectionString,
          },
        };
        const driver = sqlDrivers.get(rtSqlDriver.driver);
        if (driver) {
          try {
            const [tableRows, columnRows, pkRows] = await Promise.all([
              driver.query(
                rtConnectionString,
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
              ),
              driver.query(
                rtConnectionString,
                "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
              ),
              driver.query(
                rtConnectionString,
                "SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'",
              ),
            ]);

            const tables = (tableRows as Array<{ table_name: string }>).map((t) => {
              const cols = (
                columnRows as Array<{ table_name: string; column_name: string; data_type: string }>
              ).flatMap((col) =>
                col.table_name === t.table_name
                  ? [{ name: col.column_name, type: col.data_type }]
                  : [],
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

            enrichedInstance = {
              ...enrichedInstance,
              resolvedOutputs: {
                ...enrichedInstance.resolvedOutputs,
                __tables__: JSON.stringify(tables),
              },
            };
          } catch {
            /* introspection failed — still enable SQL editor */
          }
          sqlOk = true;
        }
      }
    } catch {
      /* resolveOutput failed */
    }
  }

  if (client.enrichDetail) {
    try {
      enrichedInstance = await client.enrichDetail(enrichedInstance);
    } catch {
      /* enrichment is best-effort — renderDetail still runs on the base resource */
    }
  }

  const detailSchema = client.renderDetail(enrichedInstance);

  // Inject sqlEditor if per-resource SQL driver is active but plugin didn't provide one
  const finalSchema: DetailViewSchema =
    rtSqlDriver && sqlOk && !detailSchema.sqlEditor
      ? {
          ...detailSchema,
          sqlEditor: {
            connectionStringOutputKey: rtSqlDriver.connectionStringOutputKey,
            defaultQuery:
              "SELECT * FROM information_schema.tables WHERE table_schema = 'public' LIMIT 20;",
            ...(enrichedInstance.resolvedOutputs?.["__tables__"]
              ? { tables: JSON.parse(enrichedInstance.resolvedOutputs["__tables__"]) }
              : {}),
          },
        }
      : detailSchema;

  const peerPanes: Array<{
    tabLabel: string;
    pluginLogoSvg: string;
    schema: PeerPaneSchema;
    peerPluginId: string;
  }> = [];
  const peerIntegrationStubs: Array<{
    tabLabel: string;
    pluginLogoSvg: string;
    peerPluginId: string;
  }> = [];

  if (resourceTypeDef?.peerIntegrations?.length) {
    const visibleIntegrations = filterVisiblePeerIntegrations(
      resourceTypeDef.peerIntegrations,
      enrichedInstance.fields,
    );
    if (includePeerPanes) {
      const builtPanes = await buildPeerPanes(
        client,
        plugin,
        visibleIntegrations,
        resourceTypeId,
        resourceId,
        accountId,
        organizationId,
      );
      peerPanes.push(...builtPanes);
    } else {
      for (const integration of visibleIntegrations) {
        const peerLoaded = await getPlugin(integration.pluginId);
        if (!peerLoaded) continue;
        peerIntegrationStubs.push({
          tabLabel: integration.tabLabel,
          pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
          peerPluginId: integration.pluginId,
        });
      }
    }
  }

  const childTypes = plugin.resourceTypes.flatMap((rt) =>
    rt.parentTypeId === resourceTypeId
      ? [
          {
            id: rt.id,
            displayName: rt.displayName,
            pluralDisplayName: rt.pluralDisplayName,
            supportsCreate: rt.supportsCreate ?? false,
            // Ship the field schema for child types that support update, so the
            // detail view can render an inline edit form for child-table rows.
            ...(rt.supportsUpdate ? { fields: rt.fields } : {}),
          },
        ]
      : [],
  );

  const childResults = await Promise.allSettled(
    childTypes.map((ct) => client.listResources(ct.id, account.id)),
  );

  const childResources: Array<{
    id: string;
    displayName: string;
    resourceTypeId: string;
    pluginId: string;
    accountId: string;
    status?: { kind: "status-dot"; status: string; label?: string };
    fields?: Record<string, unknown>;
  }> = [];
  // Only ship per-child field bags when the detail view actually renders a
  // child table for that type — otherwise it's wasted payload.
  const childTableTypeIds = new Set((finalSchema.childTables ?? []).map((t) => t.typeId));
  for (let i = 0; i < childResults.length; i++) {
    const result = childResults[i]!;
    if (result.status !== "fulfilled") continue;
    for (const r of result.value) {
      if (r.parentResourceId !== resourceId) continue;
      const sidebar = client.renderSidebarItem(r);
      childResources.push({
        id: r.id,
        displayName: r.displayName,
        resourceTypeId: r.resourceTypeId,
        pluginId: r.pluginId,
        accountId: r.accountId,
        ...(sidebar.status ? { status: sidebar.status } : {}),
        ...(childTableTypeIds.has(r.resourceTypeId) ? { fields: r.fields ?? {} } : {}),
      });
    }
  }

  const canDelete = !!client.deleteResource && resourceTypeDef?.supportsDelete !== false;
  const canEdit = !!client.updateResource && !!resourceTypeDef?.supportsUpdate;
  const editableFields = canEdit
    ? (resourceTypeDef?.fields ?? []).flatMap((f) =>
        f.editable !== false && f.kind !== "secret" && f.kind !== "association"
          ? [
              {
                key: f.key,
                label: f.label,
                kind: f.kind,
                required: f.required,
                ...(f.description ? { description: f.description } : {}),
                ...(f.enumValues ? { enumValues: f.enumValues } : {}),
              },
            ]
          : [],
      )
    : [];
  const credentialFormats =
    client.exportCredential && resourceTypeDef?.credentialFormats
      ? resourceTypeDef.credentialFormats
      : [];
  const supportsTerraformExport =
    plugin.terraformExport?.supportedResourceTypeIds.includes(resourceTypeId) ?? false;
  const hasManifestEditor = !!finalSchema.manifestEditor && !!client.getManifest;
  const hasSecretVersions =
    !!finalSchema.secretVersions &&
    !!client.listSecretVersions &&
    !!client.accessSecretVersion &&
    !!client.addSecretVersion &&
    !!client.modifySecretVersion;
  const resourceTypeLabel = resourceTypeDef?.displayName ?? "Resource";

  const hasSqlEditor =
    !!finalSchema.sqlEditor ||
    !!manifest.sqlDriver ||
    !!resourceTypeDef?.resourceSqlDriver ||
    !!client.executeQuery;
  const hasStorageBrowser = !!finalSchema.storageBrowser;
  const hasArtifactRegistry = !!finalSchema.artifactRegistry && !!client.listArtifacts;
  const hasKvBrowser = !!finalSchema.kvBrowser && !!client.listKvKeys;
  const hasKvConsole = !!manifest.kvDriver;
  const kvDriverName = manifest.kvDriver?.driver;
  const isMongoDb = kvDriverName === "mongodb";
  const hasDockerActions = !!manifest.dockerDriver;
  const sshConfig = client.getSshConfig?.();

  // Resolve SSH host from resource type's sshEndpoint declaration (like desktop)
  // This enables SSH/SFTP for cloud VMs (AWS EC2, DO droplets, Hetzner servers, etc.)
  let sshHost: string | null = null;
  let sshPrivateHost: string | null = null;
  if (resourceTypeDef?.sshEndpoint) {
    const { hostOutputKey, privateHostOutputKey, runningWhen } = resourceTypeDef.sshEndpoint;
    // If runningWhen is specified, only enable SSH when the field matches
    let isVmRunning = true;
    if (runningWhen) {
      const fieldVal = String(enrichedInstance.fields?.[runningWhen.fieldKey] ?? "");
      isVmRunning = fieldVal.toLowerCase() === runningWhen.value.toLowerCase();
    }
    if (isVmRunning) {
      const host = String(
        enrichedInstance.resolvedOutputs?.[hostOutputKey] ??
          enrichedInstance.fields?.[hostOutputKey] ??
          "",
      );
      if (host) sshHost = host;
      if (privateHostOutputKey) {
        const priv = String(
          enrichedInstance.resolvedOutputs?.[privateHostOutputKey] ??
            enrichedInstance.fields?.[privateHostOutputKey] ??
            "",
        );
        if (priv) sshPrivateHost = priv;
      }
    }
  }

  // Resolve SSH username from the sshEndpoint declaration
  let defaultSshUsername: string | null = null;
  if (resourceTypeDef?.sshEndpoint && sshHost) {
    const { usernameFieldKey, defaultUsername } = resourceTypeDef.sshEndpoint;
    if (usernameFieldKey) {
      const val = String(enrichedInstance.fields?.[usernameFieldKey] ?? "");
      if (val) defaultSshUsername = val;
    }
    if (!defaultSshUsername && defaultUsername) {
      defaultSshUsername = defaultUsername;
    }
  }

  const isRunning = finalSchema.status?.status === "healthy";
  const hasSshTerminal = isRunning && (!!sshConfig || !!sshHost);
  const hasSftpBrowser = isRunning && (!!sshConfig || !!sshHost);
  const containerId = String(
    instance.resolvedOutputs?.["containerId"] ?? instance.externalId ?? "",
  );
  const databaseName = String(instance.fields?.["database"] ?? "test");
  const storageBucketName = finalSchema.storageBrowser?.bucketName ?? "";

  return c.json({
    detailSchema: finalSchema,
    childResources,
    childTypes,
    pluginId,
    pluginLogoSvg: loadedPlugin.plugin.manifest.logoSvg,
    resourceId,
    accountId,
    resourceTypeId,
    peerPanes,
    peerIntegrationStubs,
    canDelete,
    canEdit,
    editableFields,
    credentialFormats,
    supportsTerraformExport,
    hasManifestEditor,
    hasSecretVersions,
    resourceDisplayName: instance.displayName,
    resourceTypeLabel,
    resourceFields: enrichedInstance.fields ?? {},
    hasSqlEditor,
    hasStorageBrowser,
    hasArtifactRegistry,
    hasKvBrowser,
    hasKvConsole,
    kvDriverName,
    isMongoDb,
    hasDockerActions,
    hasSshTerminal,
    hasSftpBrowser,
    sshHost,
    sshPrivateHost,
    defaultSshUsername,
    containerId,
    databaseName,
    storageBucketName,
    supportsMetrics:
      ((resourceTypeDef?.supportsMetrics ?? false) && !!client.fetchMetricSeries) ||
      (resourceTypeDef?.peerIntegrations?.some((i) => i.exposeMetricsToParent) ?? false),
    // Sleep/wake eligibility — discovered from the plugin's lifecycle
    // declaration, never from provider names.
    schedulable: !!resourceTypeDef?.lifecycle && !!client.invokeAction,
  });
});

registerManifestRoutes(app);
registerSecretVersionRoutes(app);
registerLifecycleRoutes(app);
registerActionRoutes(app);

export { app as resourceDetailRoutes };
