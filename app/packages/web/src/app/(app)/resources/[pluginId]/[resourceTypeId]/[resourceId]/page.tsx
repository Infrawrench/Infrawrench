import { requireAuth } from "@/auth/session";
import { db } from "@/db/client";
import { accounts, resources, secretFieldStates } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { getPlugin } from "@/plugins/loader";
import { decrypt } from "@/services/encryption";
import type { ResourceInstance, SecretFieldState, SecretResolution, PeerPaneSchema, DetailViewSchema } from "@infrawrench/plugin-base";
import { notFound } from "next/navigation";
import { ResourceDetailClient } from "@/components/ResourceDetailClient";
import { buildPluginHostServices } from "@/services/host-services";
import { sqlDrivers } from "@/services/drivers";

interface Props {
  params: Promise<{ pluginId: string; resourceTypeId: string; resourceId: string }>;
}

export default async function ResourceDetailPage({ params }: Props) {
  const { organizationId } = await requireAuth();
  const { pluginId, resourceTypeId, resourceId: rawResourceId } = await params;
  const resourceId = decodeURIComponent(rawResourceId);

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
  if (!loadedPlugin) notFound();

  // Resolve the account — either from the DB resource or from the resource ID
  // (format: "{accountId}:{typeId}:{externalId}")
  const accountId = dbResource?.accountId ?? resourceId.split(":")[0];
  if (!accountId) notFound();

  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, accountId),
        eq(accounts.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!account) notFound();

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;
  const hostServices = buildPluginHostServices(loadedPlugin.plugin.manifest, credentials);
  const client = loadedPlugin.plugin.createClient(credentials, hostServices);

  // Build the ResourceInstance — from DB if available, otherwise fetch live from API
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
    // Resource not in DB — fetch live from plugin API (e.g. child resource not yet synced)
    const allResources = await client.listResources(resourceTypeId, accountId);
    const found = allResources.find((r) => r.id === resourceId);
    if (!found) notFound();
    instance = found;
  }

  const resourceTypeDef = loadedPlugin.plugin.resourceTypes.find(
    (t) => t.id === resourceTypeId,
  );

  // ── SQL introspection (mirrors desktop) ───────────────────────────────────
  // Try to introspect tables so the SQL sidecar is populated.
  let sqlOk = false;
  let enrichedInstance = instance;

  // Path 1: Plugin-level introspection (introspectResource or introspect)
  const manifest = loadedPlugin.plugin.manifest;
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

  // Path 2: Per-resource SQL driver (e.g. Neon, Turso, Databricks)
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
                .filter((c) => c.table_name === t.table_name)
                .map((c) => ({ name: c.column_name, type: c.data_type }));
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

  // Inject sqlEditor into schema if per-resource SQL driver is active but plugin didn't provide one
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

  // ── Peer pane integrations ─────────────────────────────────────────────────
  // Mirror desktop: resolve outputs for each peer integration, create peer
  // client, call renderPeerPane, and pass the result schemas to the client.
  const peerPanes: Array<{
    tabLabel: string;
    pluginLogoSvg: string;
    schema: PeerPaneSchema;
  }> = [];

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
            parentPluginId: loadedPlugin.plugin.manifest.id,
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
          // Peer failed (e.g. cluster provisioning) — show provisioning placeholder
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

  // ── Child resources ────────────────────────────────────────────────────────
  const childTypes = loadedPlugin.plugin.resourceTypes
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
    status?: { kind: "status-dot"; status: string; label?: string } | undefined;
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
        status: sidebar.status,
      });
    }
  }

  // ── Capabilities ───────────────────────────────────────────────────────────
  const canDelete = !!client.deleteResource;
  const hasManifestEditor = !!finalSchema.manifestEditor && !!client.getManifest;
  const resourceTypeLabel = resourceTypeDef?.displayName ?? "Resource";

  // ── Connection feature flags ──────────────────────────────────────────────
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

  return (
    <ResourceDetailClient
      detailSchema={finalSchema}
      childResources={childResources}
      childTypes={childTypes}
      pluginId={pluginId}
      pluginLogoSvg={loadedPlugin.plugin.manifest.logoSvg}
      resourceId={resourceId}
      accountId={accountId}
      resourceTypeId={resourceTypeId}
      peerPanes={peerPanes}
      canDelete={canDelete}
      hasManifestEditor={hasManifestEditor}
      resourceTypeLabel={resourceTypeLabel}
      hasSqlEditor={hasSqlEditor}
      hasStorageBrowser={hasStorageBrowser}
      hasKvConsole={hasKvConsole}
      kvDriverName={kvDriverName}
      isMongoDb={isMongoDb}
      hasDockerActions={hasDockerActions}
      hasSshTerminal={hasSshTerminal}
      hasSftpBrowser={hasSftpBrowser}
      containerId={containerId}
      databaseName={databaseName}
      storageBucketName={storageBucketName}
    />
  );
}
