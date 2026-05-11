import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { resources, secretFieldStates } from "../../db/schema";
import { getPlugin } from "../../plugins/loader";
import { sqlDrivers } from "../../services/drivers";
import { encrypt, buildAad } from "../../services/encryption";
import {
  getClientForAccount,
  getClientForResource,
  buildPeerPanes,
} from "../../services/plugin-clients";
import { loadSecretStatesForResource } from "../../services/secret-states";
import type { ResourceInstance, DetailViewSchema } from "@infrawrench/plugin-base";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

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
  const { client, plugin, credentials, account } = ctx;

  // Build the ResourceInstance — always fetch live data from the provider
  // (like desktop does) so status changes (e.g. provisioning → running)
  // are reflected immediately.
  let instance: ResourceInstance;

  let liveResources: ResourceInstance[] = [];
  let liveFetchOk = false;
  try {
    liveResources = await client.listResources(resourceTypeId, accountId);
    liveFetchOk = true;
  } catch {
    // Provider API failed — fall back to DB data
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
              )
                .filter((col) => col.table_name === t.table_name)
                .map((col) => ({ name: col.column_name, type: col.data_type }));
              const pks = (pkRows as Array<{ table_name: string; column_name: string }>)
                .filter((p) => p.table_name === t.table_name)
                .map((p) => p.column_name);
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
    schema: unknown;
    peerPluginId: string;
  }> = [];
  const peerIntegrationStubs: Array<{
    tabLabel: string;
    pluginLogoSvg: string;
    peerPluginId: string;
  }> = [];

  if (resourceTypeDef?.peerIntegrations?.length) {
    const fields = enrichedInstance.fields ?? {};
    const visibleIntegrations = resourceTypeDef.peerIntegrations.filter((i) => {
      if (!i.showWhen) return true;
      const v = fields[i.showWhen.fieldKey];
      if (v == null || v === "") return false;
      const s = String(v);
      if (i.showWhen.equals != null) return s === i.showWhen.equals;
      if (i.showWhen.prefix != null) return s.startsWith(i.showWhen.prefix);
      return true;
    });
    if (includePeerPanes) {
      const builtPanes = await buildPeerPanes(
        client,
        plugin,
        visibleIntegrations,
        resourceTypeId,
        resourceId,
        accountId,
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

  const childTypes = plugin.resourceTypes
    .filter((rt) => rt.parentTypeId === resourceTypeId)
    .map((rt) => ({
      id: rt.id,
      displayName: rt.displayName,
      pluralDisplayName: rt.pluralDisplayName,
      supportsCreate: rt.supportsCreate ?? false,
    }));

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
  }> = [];
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
      });
    }
  }

  const canDelete = !!client.deleteResource && resourceTypeDef?.supportsDelete !== false;
  const credentialFormats =
    client.exportCredential && resourceTypeDef?.credentialFormats
      ? resourceTypeDef.credentialFormats
      : [];
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
  const hasKvConsole = !!manifest.kvDriver;
  const kvDriverName = manifest.kvDriver?.driver;
  const isMongoDb = kvDriverName === "mongodb";
  const hasDockerActions = !!manifest.dockerDriver;
  const sshConfig = client.getSshConfig?.();

  // Resolve SSH host from resource type's sshEndpoint declaration (like desktop)
  // This enables SSH/SFTP for cloud VMs (AWS EC2, DO droplets, Hetzner servers, etc.)
  let sshHost: string | null = null;
  if (resourceTypeDef?.sshEndpoint) {
    const { hostOutputKey, runningWhen } = resourceTypeDef.sshEndpoint;
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
    credentialFormats,
    hasManifestEditor,
    hasSecretVersions,
    resourceDisplayName: instance.displayName,
    resourceTypeLabel,
    resourceFields: enrichedInstance.fields ?? {},
    hasSqlEditor,
    hasStorageBrowser,
    hasArtifactRegistry,
    hasKvConsole,
    kvDriverName,
    isMongoDb,
    hasDockerActions,
    hasSshTerminal,
    hasSftpBrowser,
    sshHost,
    defaultSshUsername,
    containerId,
    databaseName,
    storageBucketName,
    supportsMetrics: (resourceTypeDef?.supportsMetrics ?? false) && !!client.fetchMetricSeries,
  });
});

/** GET /api/resources/:pluginId/:typeId/manifest?resourceId=...&accountId=...&parentResourceId=... */
app.get("/:pluginId/:typeId/manifest", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "Missing accountId" }, 400);
  const parentResourceId = c.req.query("parentResourceId");

  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.getManifest)
    return c.json({ error: "Plugin does not support manifest viewing" }, 400);

  const manifest = await ctx.client.getManifest(resourceId, accountId);
  return c.json({ manifest });
});

/** POST /api/resources/:pluginId/:typeId/manifest */
app.post("/:pluginId/:typeId/manifest", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const { accountId, resourceId, manifest, parentResourceId } = await c.req.json<{
    accountId: string;
    resourceId: string;
    manifest: string;
    parentResourceId?: string;
  }>();

  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.applyManifest)
    return c.json({ error: "Plugin does not support manifest editing" }, 400);

  await ctx.client.applyManifest(resourceId, accountId, manifest);
  return c.json({ ok: true });
});

/** POST /api/resources/:pluginId/import-yaml — kubectl apply -f equivalent */
app.post("/:pluginId/import-yaml", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const { accountId, yaml, parentResourceId } = await c.req.json<{
    accountId: string;
    yaml: string;
    parentResourceId?: string;
  }>();

  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.importYaml) return c.json({ error: "Plugin does not support YAML import" }, 400);

  const result = await ctx.client.importYaml(accountId, yaml);
  return c.json(result);
});

/** POST /api/resources/:pluginId/:typeId/describe */
app.post("/:pluginId/:typeId/describe", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const { accountId, resourceId, parentResourceId } = await c.req.json<{
    accountId: string;
    resourceId: string;
    parentResourceId?: string;
  }>();
  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) {
    return c.json({ error: "Account or peer resource not found" }, 404);
  }
  if (!ctx.client.describeResource) {
    return c.json({ error: "Plugin does not support describe" }, 400);
  }

  const text = await ctx.client.describeResource(resourceTypeId, resourceId, accountId);
  return c.json({ text });
});

/** POST /api/resources/:pluginId/:typeId/logs */
app.post("/:pluginId/:typeId/logs", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const { accountId, resourceId, parentResourceId, tailLines, container, previous } =
    await c.req.json<{
      accountId: string;
      resourceId: string;
      parentResourceId?: string;
      tailLines?: number;
      container?: string;
      previous?: boolean;
    }>();
  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) {
    return c.json({ error: "Account or peer resource not found" }, 404);
  }
  if (!ctx.client.getLogs) {
    return c.json({ error: "Plugin does not support logs" }, 400);
  }

  const result = await ctx.client.getLogs(resourceTypeId, resourceId, accountId, {
    ...(tailLines !== undefined ? { tailLines } : {}),
    ...(container !== undefined ? { container } : {}),
    ...(previous !== undefined ? { previous } : {}),
  });
  return c.json(result);
});

/** GET /api/resources/:pluginId/:typeId/secret-versions?resourceId=...&accountId=...&parentResourceId=... */
app.get("/:pluginId/:typeId/secret-versions", async (c) => {
  requirePermission(c, "secrets:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "Missing accountId" }, 400);
  const parentResourceId = c.req.query("parentResourceId");

  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.listSecretVersions)
    return c.json({ error: "Plugin does not support secret versions" }, 400);

  const versions = await ctx.client.listSecretVersions(resourceTypeId, resourceId, accountId);
  return c.json({ versions });
});

/** POST /api/resources/:pluginId/:typeId/secret-versions/access */
app.post("/:pluginId/:typeId/secret-versions/access", async (c) => {
  requirePermission(c, "secrets:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const { accountId, resourceId, versionId, parentResourceId } = await c.req.json<{
    accountId: string;
    resourceId: string;
    versionId: string;
    parentResourceId?: string;
  }>();

  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.accessSecretVersion)
    return c.json({ error: "Plugin does not support secret versions" }, 400);

  const value = await ctx.client.accessSecretVersion(
    resourceTypeId,
    resourceId,
    accountId,
    versionId,
  );
  return c.json({ value });
});

/** POST /api/resources/:pluginId/:typeId/secret-versions/add */
app.post("/:pluginId/:typeId/secret-versions/add", async (c) => {
  requirePermission(c, "secrets:write");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const { accountId, resourceId, value, parentResourceId } = await c.req.json<{
    accountId: string;
    resourceId: string;
    value: string;
    parentResourceId?: string;
  }>();

  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.addSecretVersion)
    return c.json({ error: "Plugin does not support secret versions" }, 400);

  const version = await ctx.client.addSecretVersion(resourceTypeId, resourceId, accountId, value);
  return c.json({ version });
});

/** POST /api/resources/:pluginId/:typeId/secret-versions/modify */
app.post("/:pluginId/:typeId/secret-versions/modify", async (c) => {
  requirePermission(c, "secrets:write");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const { accountId, resourceId, versionId, action, parentResourceId } = await c.req.json<{
    accountId: string;
    resourceId: string;
    versionId: string;
    action: "enable" | "disable" | "destroy";
    parentResourceId?: string;
  }>();

  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.modifySecretVersion)
    return c.json({ error: "Plugin does not support secret versions" }, 400);

  const version = await ctx.client.modifySecretVersion(
    resourceTypeId,
    resourceId,
    accountId,
    versionId,
    action,
  );
  return c.json({ version });
});

/** DELETE /api/resources/:pluginId/:typeId?resourceId=...&accountId=...&parentResourceId=... */
app.delete("/:pluginId/:typeId", async (c) => {
  requirePermission(c, "resources:delete");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "Missing accountId" }, 400);
  const parentResourceId = c.req.query("parentResourceId");

  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.deleteResource) return c.json({ error: "Plugin does not support deletion" }, 400);

  await ctx.client.deleteResource(resourceTypeId, resourceId, accountId);
  return c.json({ ok: true });
});

/** POST /api/resources/invoke-action — invoke a plugin-defined action against a resource. */
app.post("/invoke-action", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    pluginId: string;
    accountId: string;
    resourceTypeId: string;
    resourceId: string;
    actionId: string;
    parentResourceId?: string;
  }>();
  const ctx = await getClientForResource(
    input.pluginId,
    input.accountId,
    organizationId,
    input.parentResourceId,
  );
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.invokeAction) {
    return c.json({ error: "Plugin does not support custom actions" }, 400);
  }
  try {
    await ctx.client.invokeAction(
      input.resourceTypeId,
      input.resourceId,
      input.actionId,
      input.accountId,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Action failed" }, 400);
  }
  return c.json({ ok: true });
});

/** POST /api/resources/nosql-command — run a NoSQL document-browser command against a resource. */
app.post("/nosql-command", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    pluginId: string;
    accountId: string;
    resourceTypeId: string;
    resourceId: string;
    command: string;
    args: (string | number)[];
    parentResourceId?: string;
  }>();
  const ctx = await getClientForResource(
    input.pluginId,
    input.accountId,
    organizationId,
    input.parentResourceId,
  );
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.executeNoSqlCommand) {
    return c.json({ error: "Plugin does not support NoSQL commands" }, 400);
  }
  try {
    const result = await ctx.client.executeNoSqlCommand(
      input.resourceTypeId,
      input.resourceId,
      input.accountId,
      input.command,
      input.args ?? [],
    );
    return c.json({ result });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Command failed" }, 400);
  }
});

/** POST /api/resources/attach — attach a resource onto a same-account target (e.g. disk → VM). */
app.post("/attach", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    pluginId: string;
    accountId: string;
    sourceTypeId: string;
    sourceResourceId: string;
    targetTypeId: string;
    targetResourceId: string;
  }>();

  const ctx = await getClientForResource(input.pluginId, input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.attachResource) {
    return c.json({ error: "Plugin does not support attach" }, 400);
  }
  try {
    await ctx.client.attachResource(
      input.sourceTypeId,
      input.sourceResourceId,
      input.targetTypeId,
      input.targetResourceId,
      input.accountId,
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Attach failed" }, 400);
  }
  return c.json({ ok: true });
});

/** POST /api/resources/:pluginId/:typeId/export-credential */
app.post("/:pluginId/:typeId/export-credential", async (c) => {
  requirePermission(c, "secrets:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const input = await c.req.json<{
    resourceId: string;
    accountId: string;
    formatId: string;
    parentResourceId?: string;
  }>();
  if (!input.resourceId || !input.accountId || !input.formatId) {
    return c.json({ error: "Missing resourceId, accountId, or formatId" }, 400);
  }
  const ctx = await getClientForResource(
    pluginId,
    input.accountId,
    organizationId,
    input.parentResourceId,
  );
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.exportCredential) {
    return c.json({ error: "Plugin does not support credential export" }, 400);
  }
  const result = await ctx.client.exportCredential(
    resourceTypeId,
    input.resourceId,
    input.accountId,
    input.formatId,
  );
  return c.json(result);
});

/** POST /api/resources/create */
app.post("/create", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    pluginId: string;
    resourceTypeId: string;
    fields: Record<string, string>;
    parentResourceId?: string;
  }>();

  const ctx = await getClientForResource(
    input.pluginId,
    input.accountId,
    organizationId,
    input.parentResourceId,
  );
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.createResource) return c.json({ error: "Plugin does not support creation" }, 400);

  let createReturn;
  try {
    createReturn = await ctx.client.createResource(
      input.resourceTypeId,
      input.accountId,
      input.fields,
      input.parentResourceId,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Resource creation failed";
    return c.json({ error: message }, 400);
  }

  const { resource: created, warnings } = normalizeResourceCreateResult(createReturn);

  // Persist top-level (non-peer) resources to DB so the detail page can find
  // them without waiting for the next sync. Peer resources (e.g. k8s-pod on
  // a gcloud account) are not stored here since they aren't owned by the
  // account's native plugin.
  if (ctx.account.pluginId === input.pluginId) {
    try {
      await db
        .insert(resources)
        .values({
          id: created.id,
          organizationId,
          pluginId: input.pluginId,
          resourceTypeId: input.resourceTypeId,
          accountId: input.accountId,
          displayName: created.displayName,
          externalId: created.externalId ?? null,
          fieldsJson: created.fields ?? {},
          outputsJson: created.resolvedOutputs ?? {},
          parentResourceId: created.parentResourceId ?? null,
        })
        .onConflictDoUpdate({
          target: resources.id,
          set: {
            displayName: created.displayName,
            fieldsJson: created.fields ?? {},
            outputsJson: created.resolvedOutputs ?? {},
            deletedAt: null,
            updatedAt: new Date(),
          },
        });

      // Encrypt and persist any plaintext secretStates the plugin returned.
      // Plugins never see ciphertext; the host upgrades plaintext -> literal here.
      for (const state of created.secretStates ?? []) {
        if (state.resolution.kind !== "plaintext") continue;
        const { ciphertext, iv } = await encrypt(
          state.resolution.value,
          buildAad("secretField", `${created.id}:${state.fieldKey}`, "value"),
        );
        await db
          .insert(secretFieldStates)
          .values({
            id: uuidv4(),
            resourceId: created.id,
            fieldKey: state.fieldKey,
            resolutionKind: "literal",
            encryptedValue: ciphertext,
            valueIv: iv,
          })
          .onConflictDoUpdate({
            target: [secretFieldStates.resourceId, secretFieldStates.fieldKey],
            set: {
              resolutionKind: "literal",
              encryptedValue: ciphertext,
              valueIv: iv,
              sourcePluginId: null,
              sourceResourceTypeId: null,
              sourceResourceId: null,
              sourceAccountId: null,
              sourceOutputKey: null,
              cachedEncryptedValue: null,
              cachedValueIv: null,
              cachedAt: null,
              updatedAt: new Date(),
            },
          });
      }
    } catch {
      // Non-critical — detail page will fall back to listResources
    }
  }

  return c.json({ id: created.id, displayName: created.displayName, warnings });
});

/** POST /api/resources/create-config */
app.post("/create-config", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    resourceTypeId: string;
    pluginId?: string;
    parentResourceId?: string;
  }>();

  const ctx = input.pluginId
    ? await getClientForResource(
        input.pluginId,
        input.accountId,
        organizationId,
        input.parentResourceId,
      )
    : await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.getCreateConfig)
    return c.json({ error: "Plugin does not support dynamic create config" }, 400);

  const config = await ctx.client.getCreateConfig(input.resourceTypeId, input.parentResourceId);
  return c.json(config);
});

/** POST /api/resources/picker-resources — get resources for resource-picker field */
app.post("/picker-resources", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    sources: Array<{ pluginId: string; resourceTypeId: string; outputKey: string }>;
    accountId: string;
  }>();

  const results: Array<{
    id: string;
    label: string;
    pluginId: string;
    resourceTypeId: string;
    accountId: string;
    outputKey: string;
    outputValue: string;
  }> = [];

  for (const source of input.sources) {
    try {
      const ctx = await getClientForAccount(input.accountId, organizationId);
      if (!ctx || ctx.plugin.manifest.id !== source.pluginId) continue;

      const resources = await ctx.client.listResources(source.resourceTypeId, input.accountId);
      for (const resource of resources) {
        try {
          // Prefer the value the lister already populated — avoids an N+1
          // re-list when resolveOutput would just re-fetch the same data.
          const preResolved = resource.resolvedOutputs[source.outputKey];
          const outputValue =
            preResolved != null && String(preResolved) !== ""
              ? String(preResolved)
              : await ctx.client.resolveOutput(
                  source.resourceTypeId,
                  resource.id,
                  source.outputKey,
                  input.accountId,
                );
          results.push({
            id: resource.id,
            label: resource.displayName,
            pluginId: source.pluginId,
            resourceTypeId: source.resourceTypeId,
            accountId: input.accountId,
            outputKey: source.outputKey,
            outputValue,
          });
        } catch {
          // Skip resources where output can't be resolved
        }
      }
    } catch {
      // Skip sources that fail
    }
  }

  return c.json(results);
});

/** POST /api/resources/create-pricing — get size pricing for create form */
app.post("/create-pricing", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    resourceTypeId: string;
    regionId?: string;
    sizes: Array<{ id: string; vcpus: number; memoryMb: number }>;
    pluginId?: string;
    parentResourceId?: string;
  }>();

  const ctx = input.pluginId
    ? await getClientForResource(
        input.pluginId,
        input.accountId,
        organizationId,
        input.parentResourceId,
      )
    : await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.getCreateSizePricing) return c.json({});

  const pricing = await ctx.client.getCreateSizePricing(input.resourceTypeId, {
    ...(input.regionId ? { regionId: input.regionId } : {}),
    sizes: input.sizes,
  });
  return c.json(pricing ?? {});
});

/** POST /api/resources/create-cost-estimate — get cost estimate for create form */
app.post("/create-cost-estimate", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    resourceTypeId: string;
    fields: Record<string, string>;
    pluginId?: string;
    parentResourceId?: string;
  }>();

  const ctx = input.pluginId
    ? await getClientForResource(
        input.pluginId,
        input.accountId,
        organizationId,
        input.parentResourceId,
      )
    : await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.getCreateCostEstimate) return c.json({ estimate: null });

  const estimate = await ctx.client.getCreateCostEstimate(input.resourceTypeId, input.fields);
  return c.json({ estimate: estimate ?? null });
});

/** POST /api/resources/:pluginId/:typeId/peer-panes */
app.post("/:pluginId/:typeId/peer-panes", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const { accountId, resourceId, parentResourceId } = await c.req.json<{
    accountId: string;
    resourceId: string;
    parentResourceId?: string;
  }>();

  const ctx = parentResourceId
    ? await getClientForResource(pluginId, accountId, organizationId, parentResourceId)
    : await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);

  const resourceTypeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
  if (!resourceTypeDef?.peerIntegrations?.length) return c.json([]);

  const panes = await buildPeerPanes(
    ctx.client,
    ctx.plugin,
    resourceTypeDef.peerIntegrations,
    resourceTypeId,
    resourceId,
    accountId,
  );

  return c.json(panes);
});

/** POST /api/resources/:pluginId/:typeId/metrics */
app.post("/:pluginId/:typeId/metrics", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const { accountId, resourceId, startMs, endMs, parentResourceId } = await c.req.json<{
    accountId: string;
    resourceId: string;
    startMs?: number;
    endMs?: number;
    parentResourceId?: string;
  }>();
  const resourceTypeId = c.req.param("typeId");

  const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
  if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
  if (!ctx.client.fetchMetricSeries)
    return c.json({ error: "Plugin does not support metrics" }, 400);

  const timeRange = startMs && endMs ? { startMs, endMs } : undefined;
  const series = await ctx.client.fetchMetricSeries(
    resourceTypeId,
    resourceId,
    accountId,
    timeRange,
  );
  return c.json({ series });
});

export { app as resourceDetailRoutes };
