import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, resources, secretFieldStates } from "../../db/schema";
import { decrypt } from "../../services/encryption";
import { getPlugin } from "../../plugins/loader";
import { buildPluginHostServices } from "../../services/host-services";
import { sqlDrivers } from "../../services/drivers";
import type {
  ResourceInstance,
  SecretFieldState,
  SecretResolution,
  DetailViewSchema,
} from "@infrawrench/plugin-base";
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

/** GET /api/resources/:pluginId/:typeId/detail?resourceId=... — full resource detail payload */
app.get("/:pluginId/:typeId/detail", async (c) => {
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const resourceTypeId = c.req.param("typeId");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);

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

  const accountId = dbResource?.accountId ?? c.req.query("accountId") ?? resourceId.split(":")[0];
  if (!accountId) return c.json({ error: "Cannot resolve account" }, 404);

  const ctx = await getClientForAccount(accountId, organizationId);
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
    instance = liveInstance;
    // Update DB with fresh data in the background
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
      .catch(() => {});
  } else if (liveFetchOk && dbResource?.lastSyncedAt) {
    // Provider listed resources successfully but this one wasn't included,
    // and it was previously synced — it's been deleted externally.
    db.update(resources)
      .set({ deletedAt: new Date() })
      .where(eq(resources.id, resourceId))
      .catch(() => {});
    return c.json({ error: "Resource not found" }, 404);
  } else if (dbResource) {
    // Provider API failed OR resource was never synced (just created) — use DB data
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
                  ...(s.cachedEncryptedValue != null && {
                    cachedEncryptedValue: s.cachedEncryptedValue,
                  }),
                  ...(s.cachedValueIv != null && { cachedIv: s.cachedValueIv }),
                  ...(s.cachedAt != null && { cachedAt: s.cachedAt.toISOString() }),
                } satisfies SecretResolution),
        }),
      ),
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

          const peerHostServices = buildPluginHostServices(
            peerLoaded.plugin.manifest,
            peerCredentials,
          );
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

  const canDelete = !!client.deleteResource;
  const hasManifestEditor = !!finalSchema.manifestEditor && !!client.getManifest;
  const resourceTypeLabel = resourceTypeDef?.displayName ?? "Resource";

  const hasSqlEditor =
    !!finalSchema.sqlEditor ||
    !!manifest.sqlDriver ||
    !!resourceTypeDef?.resourceSqlDriver ||
    !!client.executeQuery;
  const hasStorageBrowser = !!finalSchema.storageBrowser;
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
    canDelete,
    hasManifestEditor,
    resourceDisplayName: instance.displayName,
    resourceTypeLabel,
    hasSqlEditor,
    hasStorageBrowser,
    hasKvConsole,
    kvDriverName,
    isMongoDb,
    hasDockerActions,
    hasSshTerminal,
    hasSftpBrowser,
    sshHost,
    containerId,
    databaseName,
    storageBucketName,
  });
});

/** GET /api/resources/:pluginId/:typeId/manifest?resourceId=...&accountId=... */
app.get("/:pluginId/:typeId/manifest", async (c) => {
  const organizationId = c.get("organizationId");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "Missing accountId" }, 400);

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.getManifest)
    return c.json({ error: "Plugin does not support manifest viewing" }, 400);

  const manifest = await ctx.client.getManifest(resourceId, accountId);
  return c.json({ manifest });
});

/** POST /api/resources/:pluginId/:typeId/manifest */
app.post("/:pluginId/:typeId/manifest", async (c) => {
  const organizationId = c.get("organizationId");
  const { accountId, resourceId, manifest } = await c.req.json<{
    accountId: string;
    resourceId: string;
    manifest: string;
  }>();

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.applyManifest)
    return c.json({ error: "Plugin does not support manifest editing" }, 400);

  await ctx.client.applyManifest(resourceId, accountId, manifest);
  return c.json({ ok: true });
});

/** DELETE /api/resources/:pluginId/:typeId?resourceId=...&accountId=... */
app.delete("/:pluginId/:typeId", async (c) => {
  const organizationId = c.get("organizationId");
  const resourceTypeId = c.req.param("typeId");
  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "Missing accountId" }, 400);

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.deleteResource) return c.json({ error: "Plugin does not support deletion" }, 400);

  const all = await ctx.client.listResources(resourceTypeId, accountId);
  console.log(
    `[DELETE] resourceId=${resourceId}, accountId=${accountId}, typeId=${resourceTypeId}, listed=${all.length}, match=${all.some((r) => r.id === resourceId)}`,
  );
  if (!all.some((r) => r.id === resourceId)) {
    console.log(
      "[DELETE] IDs from listResources:",
      all.map((r) => r.id),
    );
  }

  await ctx.client.deleteResource(resourceTypeId, resourceId, accountId);
  return c.json({ ok: true });
});

/** POST /api/resources/create */
app.post("/create", async (c) => {
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    pluginId: string;
    resourceTypeId: string;
    fields: Record<string, string>;
  }>();

  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.createResource) return c.json({ error: "Plugin does not support creation" }, 400);

  const created = await ctx.client.createResource(
    input.resourceTypeId,
    input.accountId,
    input.fields,
  );

  // Persist to DB immediately so the detail page can find it without
  // waiting for the next sync / provider propagation.
  // Use onConflictDoUpdate to clear deletedAt — the resource may already
  // exist from a previous sync that later soft-deleted it.
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
  } catch {
    // Non-critical — detail page will fall back to listResources
  }

  return c.json({ id: created.id, displayName: created.displayName });
});

/** POST /api/resources/create-config */
app.post("/create-config", async (c) => {
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    resourceTypeId: string;
  }>();

  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.getCreateConfig)
    return c.json({ error: "Plugin does not support dynamic create config" }, 400);

  const config = await ctx.client.getCreateConfig(input.resourceTypeId);
  return c.json(config);
});

/** POST /api/resources/create-pricing — get size pricing for create form */
app.post("/create-pricing", async (c) => {
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    resourceTypeId: string;
    regionId?: string;
    sizes: Array<{ id: string; vcpus: number; memoryMb: number }>;
  }>();

  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.getCreateSizePricing) return c.json({});

  const pricing = await ctx.client.getCreateSizePricing(input.resourceTypeId, {
    ...(input.regionId ? { regionId: input.regionId } : {}),
    sizes: input.sizes,
  });
  return c.json(pricing ?? {});
});

/** POST /api/resources/create-cost-estimate — get cost estimate for create form */
app.post("/create-cost-estimate", async (c) => {
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    accountId: string;
    resourceTypeId: string;
    fields: Record<string, string>;
  }>();

  const ctx = await getClientForAccount(input.accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  if (!ctx.client.getCreateCostEstimate) return c.json({ estimate: null });

  const estimate = await ctx.client.getCreateCostEstimate(input.resourceTypeId, input.fields);
  return c.json({ estimate: estimate ?? null });
});

/** POST /api/resources/:pluginId/:typeId/peer-panes */
app.post("/:pluginId/:typeId/peer-panes", async (c) => {
  const organizationId = c.get("organizationId");
  const resourceTypeId = c.req.param("typeId");
  const { accountId, resourceId } = await c.req.json<{ accountId: string; resourceId: string }>();

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
