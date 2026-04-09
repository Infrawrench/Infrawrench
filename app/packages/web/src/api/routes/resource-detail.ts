import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, resources, secretFieldStates } from "../../db/schema";
import { decrypt } from "../../services/encryption";
import { getPlugin } from "../../plugins/loader";
import { buildPluginHostServices } from "../../services/host-services";
import { sqlDrivers } from "../../services/drivers";
import type { ResourceInstance, SecretFieldState, SecretResolution, DetailViewSchema } from "@infrawrench/plugin-base";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

async function getClientForAccount(accountId: string, organizationId: string) {
  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);

  if (!account) return null;

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return null;

  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);
  return { client, plugin: loaded.plugin, credentials, account };
}

/** GET /api/resources/:pluginId/:typeId/:resourceId/detail — full resource detail payload */
app.get("/:pluginId/:typeId/:resourceId/detail", async (c) => {
  const { organizationId } = c.get("session");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const resourceId = decodeURIComponent(c.req.param("resourceId"));

  // Try to find the resource in the database first
  const [dbResource] = await db
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

  const accountId = dbResource?.accountId ?? resourceId.split(":")[0];
  if (!accountId) return c.json({ error: "Cannot resolve account" }, 404);

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  const { client, plugin, credentials, account } = ctx;

  // Build the ResourceInstance
  let instance: ResourceInstance;

  if (dbResource) {
    const secretStates = await db
      .select()
      .from(secretFieldStates)
      .where(eq(secretFieldStates.resourceId, resourceId));

    instance = {
      id: dbResource.id,
      pluginId: dbResource.pluginId,
      resourceTypeId: dbResource.resourceTypeId,
      accountId: dbResource.accountId,
      displayName: dbResource.displayName,
      fields: (dbResource.fieldsJson as Record<string, string | number | boolean>) ?? {},
      resolvedOutputs: (dbResource.outputsJson as Record<string, string>) ?? {},
      secretStates: secretStates.map(
        (s): SecretFieldState => ({
          fieldKey: s.fieldKey,
          resolution:
            s.resolutionKind === "literal"
              ? {
                  kind: "literal",
                  encryptedValue: s.encryptedValue ?? "",
                  iv: s.valueIv ?? "",
                }
              : ({
                  kind: "output-ref",
                  sourcePluginId: s.sourcePluginId ?? "",
                  sourceResourceTypeId: s.sourceResourceTypeId ?? "",
                  sourceResourceId: s.sourceResourceId ?? "",
                  sourceAccountId: s.sourceAccountId ?? "",
                  outputKey: s.sourceOutputKey ?? "",
                  ...(s.cachedEncryptedValue != null && { cachedEncryptedValue: s.cachedEncryptedValue }),
                  ...(s.cachedValueIv != null && { cachedIv: s.cachedValueIv }),
                  ...(s.cachedAt != null && { cachedAt: s.cachedAt.toISOString() }),
                } satisfies SecretResolution),
        }),
      ),
      ...(dbResource.externalId != null && { externalId: dbResource.externalId }),
      ...(dbResource.parentResourceId != null && { parentResourceId: dbResource.parentResourceId }),
      createdAt: dbResource.createdAt.toISOString(),
      updatedAt: dbResource.updatedAt.toISOString(),
      ...(dbResource.lastSyncedAt != null && { lastSyncedAt: dbResource.lastSyncedAt.toISOString() }),
    };
  } else {
    const allResources = await client.listResources(resourceTypeId, accountId);
    const found = allResources.find((r) => r.id === resourceId);
    if (!found) return c.json({ error: "Resource not found" }, 404);
    instance = found;
  }

  const resourceTypeDef = plugin.resourceTypes.find((t) => t.id === resourceTypeId);

  // ── SQL introspection ───────────────────────────────────────────────────
  let sqlOk = false;
  let enrichedInstance = instance;
  const manifest = plugin.manifest;

  if (manifest.sqlDriver || client.executeQuery) {
    try {
      const tables = await client.introspectResource?.(resourceId, accountId)
        ?? await client.introspect?.()
        ?? [];
      enrichedInstance = {
        ...enrichedInstance,
        resolvedOutputs: { ...enrichedInstance.resolvedOutputs, __tables__: JSON.stringify(tables) },
      };
      sqlOk = true;
    } catch { /* introspection is non-critical */ }
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
        const driver = sqlDrivers.get(rtSqlDriver.driver);
        if (driver) {
          try {
            const [tableRows, columnRows, pkRows] = await Promise.all([
              driver.query(rtConnectionString,
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"),
              driver.query(rtConnectionString,
                "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position"),
              driver.query(rtConnectionString,
                "SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'"),
            ]);

            const tables = (tableRows as Array<{ table_name: string }>).map((t) => {
              const cols = (columnRows as Array<{ table_name: string; column_name: string; data_type: string }>)
                .filter((col) => col.table_name === t.table_name)
                .map((col) => ({ name: col.column_name, type: col.data_type }));
              const pks = (pkRows as Array<{ table_name: string; column_name: string }>)
                .filter((p) => p.table_name === t.table_name)
                .map((p) => p.column_name);
              return { name: t.table_name, columns: cols, ...(pks.length > 0 ? { pkColumns: pks } : {}) };
            });

            enrichedInstance = {
              ...enrichedInstance,
              resolvedOutputs: { ...enrichedInstance.resolvedOutputs, __tables__: JSON.stringify(tables) },
            };
          } catch { /* introspection failed — still enable SQL editor */ }
          sqlOk = true;
        }
      }
    } catch { /* resolveOutput failed */ }
  }

  const detailSchema = client.renderDetail(enrichedInstance);

  // Inject sqlEditor if per-resource SQL driver is active but plugin didn't provide one
  const finalSchema: DetailViewSchema = (rtSqlDriver && sqlOk && !detailSchema.sqlEditor)
    ? {
        ...detailSchema,
        sqlEditor: {
          connectionStringOutputKey: rtSqlDriver.connectionStringOutputKey,
          defaultQuery: "SELECT * FROM information_schema.tables WHERE table_schema = 'public' LIMIT 20;",
          ...(enrichedInstance.resolvedOutputs?.["__tables__"]
            ? { tables: JSON.parse(enrichedInstance.resolvedOutputs["__tables__"]) }
            : {}),
        },
      }
    : detailSchema;

  // ── Peer pane integrations ─────────────────────────────────────────────
  const peerPanes: Array<{ tabLabel: string; pluginLogoSvg: string; schema: unknown }> = [];

  if (resourceTypeDef?.peerIntegrations?.length) {
    await Promise.allSettled(
      resourceTypeDef.peerIntegrations.map(async (integration) => {
        try {
          const peerCredentials: Record<string, string> = {};
          for (const mapping of integration.credentialMappings) {
            const value = await client.resolveOutput(
              resourceTypeId,
              resourceId,
              mapping.outputKey,
              accountId,
            );
            peerCredentials[mapping.credentialKey] = value;
          }

          const peerLoaded = await getPlugin(integration.pluginId);
          if (!peerLoaded) return;

          const peerHostServices = buildPluginHostServices(peerLoaded.plugin.manifest, peerCredentials);
          const peerClient = peerLoaded.plugin.createClient(peerCredentials, peerHostServices);
          if (!peerClient.renderPeerPane) return;

          const context = {
            tabLabel: integration.tabLabel,
            parentPluginId: plugin.manifest.id,
            parentResourceTypeId: resourceTypeId,
            parentResourceId: resourceId,
          };
          const peerSchema = await peerClient.renderPeerPane(context);

          peerPanes.push({
            tabLabel: integration.tabLabel,
            pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
            schema: peerSchema,
          });
        } catch {
          const peerLoaded = await getPlugin(integration.pluginId);
          if (!peerLoaded) return;
          peerPanes.push({
            tabLabel: integration.tabLabel,
            pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
            schema: {
              status: { kind: "status-dot", status: "provisioning", label: "Provisioning" },
              resourceGroups: [],
            },
          });
        }
      }),
    );
  }

  // ── Child resources ────────────────────────────────────────────────────
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

  // ── Capabilities ───────────────────────────────────────────────────────
  const canDelete = !!client.deleteResource;
  const hasManifestEditor = !!finalSchema.manifestEditor && !!client.getManifest;
  const resourceTypeLabel = resourceTypeDef?.displayName ?? "Resource";

  // ── Connection feature flags ──────────────────────────────────────────
  const hasSqlEditor = !!finalSchema.sqlEditor || !!manifest.sqlDriver || !!resourceTypeDef?.resourceSqlDriver || !!client.executeQuery;
  const hasStorageBrowser = !!finalSchema.storageBrowser;
  const hasKvConsole = !!manifest.kvDriver;
  const kvDriverName = manifest.kvDriver?.driver;
  const isMongoDb = kvDriverName === "mongodb";
  const hasDockerActions = !!manifest.dockerDriver;
  const sshConfig = client.getSshConfig?.();
  const hasSshTerminal = !!sshConfig;
  const hasSftpBrowser = !!sshConfig;
  const containerId = String(instance.resolvedOutputs?.["containerId"] ?? instance.externalId ?? "");
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
    canDelete,
    hasManifestEditor,
    resourceTypeLabel,
    hasSqlEditor,
    hasStorageBrowser,
    hasKvConsole,
    kvDriverName,
    isMongoDb,
    hasDockerActions,
    hasSshTerminal,
    hasSftpBrowser,
    containerId,
    databaseName,
    storageBucketName,
  });
});

// ── Manifest editor ──────────────────────────────────────────────────────────

/** GET /api/resources/:pluginId/:typeId/:resourceId/manifest */
app.get("/:pluginId/:typeId/:resourceId/manifest", async (c) => {
  const { organizationId } = c.get("session");
  const resourceId = decodeURIComponent(c.req.param("resourceId"));
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "Missing accountId" }, 400);

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.getManifest) return c.json({ error: "Plugin does not support manifest viewing" }, 400);

  const manifest = await ctx.client.getManifest(resourceId, accountId);
  return c.json({ manifest });
});

/** POST /api/resources/:pluginId/:typeId/:resourceId/manifest */
app.post("/:pluginId/:typeId/:resourceId/manifest", async (c) => {
  const { organizationId } = c.get("session");
  const resourceId = decodeURIComponent(c.req.param("resourceId"));
  const { accountId, manifest } = await c.req.json<{ accountId: string; manifest: string }>();

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.applyManifest) return c.json({ error: "Plugin does not support manifest editing" }, 400);

  await ctx.client.applyManifest(resourceId, accountId, manifest);
  return c.json({ ok: true });
});

/** DELETE /api/resources/:pluginId/:typeId/:resourceId */
app.delete("/:pluginId/:typeId/:resourceId", async (c) => {
  const { organizationId } = c.get("session");
  const resourceTypeId = c.req.param("typeId");
  const resourceId = decodeURIComponent(c.req.param("resourceId"));
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "Missing accountId" }, 400);

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.deleteResource) return c.json({ error: "Plugin does not support deletion" }, 400);

  await ctx.client.deleteResource(resourceTypeId, resourceId, accountId);
  return c.json({ ok: true });
});

/** POST /api/resources/create */
app.post("/create", async (c) => {
  const { organizationId } = c.get("session");
  const input = await c.req.json<{
    accountId: string;
    pluginId: string;
    resourceTypeId: string;
    fields: Record<string, string>;
  }>();

  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.createResource) return c.json({ error: "Plugin does not support creation" }, 400);

  const created = await ctx.client.createResource(input.resourceTypeId, input.accountId, input.fields);
  return c.json({ id: created.id, displayName: created.displayName });
});

/** POST /api/resources/:pluginId/:typeId/:resourceId/peer-panes */
app.post("/:pluginId/:typeId/:resourceId/peer-panes", async (c) => {
  const { organizationId } = c.get("session");
  const resourceTypeId = c.req.param("typeId");
  const resourceId = decodeURIComponent(c.req.param("resourceId"));
  const { accountId } = await c.req.json<{ accountId: string }>();

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);

  const resourceTypeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
  if (!resourceTypeDef?.peerIntegrations?.length) return c.json([]);

  const panes: Array<{ tabLabel: string; pluginLogoSvg: string; schema: unknown }> = [];

  await Promise.allSettled(
    resourceTypeDef.peerIntegrations.map(async (integration) => {
      try {
        const peerCredentials: Record<string, string> = {};
        for (const mapping of integration.credentialMappings) {
          const value = await ctx.client.resolveOutput(
            resourceTypeId,
            resourceId,
            mapping.outputKey,
            accountId,
          );
          peerCredentials[mapping.credentialKey] = value;
        }

        const peerLoaded = await getPlugin(integration.pluginId);
        if (!peerLoaded) return;

        const peerClient = peerLoaded.plugin.createClient(peerCredentials);
        if (!peerClient.renderPeerPane) return;

        const context = {
          tabLabel: integration.tabLabel,
          parentPluginId: ctx.plugin.manifest.id,
          parentResourceTypeId: resourceTypeId,
          parentResourceId: resourceId,
        };
        const peerSchema = await peerClient.renderPeerPane(context);

        panes.push({
          tabLabel: integration.tabLabel,
          pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
          schema: peerSchema,
        });
      } catch {
        const peerLoaded = await getPlugin(integration.pluginId);
        if (!peerLoaded) return;
        panes.push({
          tabLabel: integration.tabLabel,
          pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
          schema: {
            status: { kind: "status-dot", status: "provisioning", label: "Provisioning" },
            resourceGroups: [],
          },
        });
      }
    }),
  );

  return c.json(panes);
});

export { app as resourceDetailRoutes };
