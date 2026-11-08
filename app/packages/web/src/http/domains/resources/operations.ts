/**
 * The resource routes' multi-step plugin flows, as promise code.
 *
 * Each function here is one handler's body from the point the caller is known:
 * a chain of provider calls, database reads and writes, and best-effort
 * fallbacks, which reads AsyncLocalStorage throughout (the plugin client's
 * egress scope, the edge request scope's gateway-only tracker and `db`, the
 * secret writes a create holds). The handlers in `./index.ts` run each one
 * inside a single `legacy` call, so the whole chain starts synchronously
 * inside the request's scopes and every continuation it creates keeps them.
 *
 * A refusal is thrown as one of the API's error classes, which the handler's
 * `legacyTry` turns back into the endpoint's typed failure; anything else
 * stays a defect and renders as the Hono `onError` did.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { DetailViewSchema, ResourceInstance, SqlTableMeta } from "@infrawrench/plugin-base";
import {
  isFieldEditable,
  normalizeResourceCreateResult,
  pickShowcaseValues,
  showcaseFields,
  type OutputRefValue,
} from "@infrawrench/plugin-base";
import { guardDriverConnection } from "@infrawrench/server-core/egress-guard";
import { getMetricRange } from "@infrawrench/server-core/clickhouse/readers";
import { estimateResourceCost } from "@infrawrench/server-core/cost/estimate";
import { getConfigCarbon, getResourceCarbon } from "@infrawrench/server-core/cost/carbon";
import {
  holdSecretWrites,
  setLiteralSecretState,
  setOutputRefSecretState,
} from "@infrawrench/server-core/secret-states";
import {
  supersedeResource,
  upsertCreatedResource,
} from "@infrawrench/server-core/created-resource";
import { resourceIdBelongsToAccount } from "@infrawrench/server-core/resource-ids";
import {
  captureDeletionSaving,
  captureResizeSaving,
} from "@infrawrench/server-core/savings/capture";
import { updateAccountCredentials } from "@infrawrench/server-core/provider-oauth";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import { resourceCarbonEstimate, type ResourceCarbonEstimate } from "@infrawrench/client-core";
import { db } from "../../../db/client";
import { accounts, associations, resources } from "../../../db/schema";
import { getPlugin } from "../../../plugins/loader";
import { sqlDrivers } from "../../../services/drivers";
import {
  buildPeerPanes,
  filterVisiblePeerIntegrations,
  getClientForAccount,
  getClientForResource,
} from "../../../services/plugin-clients";
import { loadSecretStatesForResource } from "../../../services/secret-states";
import { exportStoredResourcesToTerraform } from "../../../services/terraform-export";
import { nextAssociationSyncVersion } from "../../../services/sync-versions";
import { logAudit } from "../../../services/audit";
import { BadRequest, InternalServerError, NotFound } from "../../errors";

/** A resolved account (or peer resource) client, as `getClientForResource` answers. */
export type ResourceClient = NonNullable<Awaited<ReturnType<typeof getClientForResource>>>;

/** The sentence every route answers a missing account or peer resource with. */
export const ACCOUNT_OR_PEER_NOT_FOUND = "Account or peer resource not found";

/**
 * A stored field bag as a plugin reads it. The host only ever writes a
 * plugin's `fields` (primitives) and `resolvedOutputs` (strings) to these
 * columns, so this keeps every value they hold.
 */
function storedFields(json: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function storedOutputs(json: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export interface DetailRequest {
  readonly organizationId: string;
  readonly pluginId: string;
  readonly resourceTypeId: string;
  readonly resourceId: string;
  readonly accountId: string | undefined;
  readonly parentResourceId: string | undefined;
  /** When false, skip the expensive peer pane fetch and return only stubs. */
  readonly includePeerPanes: boolean;
}

/** `GET /:pluginId/:typeId/detail`: the full resource detail payload. */
export async function loadResourceDetail(input: DetailRequest) {
  const { organizationId, pluginId, resourceTypeId, resourceId, parentResourceId } = input;
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
  if (!loadedPlugin) throw new NotFound({ error: "Plugin not found" });

  const accountId = dbResource?.accountId ?? input.accountId ?? resourceId.split(":")[0];
  if (!accountId) throw new NotFound({ error: "Cannot resolve account" });

  const ctx = parentResourceId
    ? await getClientForResource(pluginId, accountId, organizationId, parentResourceId)
    : await getClientForAccount(accountId, organizationId);
  if (!ctx) throw new NotFound({ error: "Account not found" });
  const { client, plugin, account } = ctx;

  // Always fetch live data from the provider (like desktop does) so status
  // changes (e.g. provisioning to running) are reflected immediately.
  let instance: ResourceInstance;

  let liveResources: ResourceInstance[] = [];
  let liveFetchOk = false;
  try {
    liveResources = await client.listResources(resourceTypeId, accountId);
    liveFetchOk = true;
  } catch (err) {
    // Provider API failed: fall back to DB data. Log so dev sees provider regressions.
    console.error(
      `[resource-detail] Provider listResources failed for ${pluginId}/${resourceTypeId}:`,
      err,
    );
  }
  const liveInstance = liveResources.find((r) => r.id === resourceId);

  if (liveInstance) {
    // Overlay any DB-persisted secretStates (decrypted to plaintext) onto the
    // live instance: listers don't return create-time secrets like passwords.
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
          // Ids are global; never refresh a row another org owns.
          setWhere: eq(resources.organizationId, organizationId),
        })
        .catch((e) => console.error("[resource-detail] Failed to upsert:", e));
    }
  } else if (liveFetchOk && dbResource?.lastSyncedAt) {
    // Provider listed resources successfully but this one wasn't included,
    // and it was previously synced: it's been deleted externally.
    db.update(resources)
      .set({ deletedAt: new Date() })
      .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
      .catch((e) => console.error("[resource-detail] Failed to soft-delete:", e));
    throw new NotFound({ error: "Resource not found" });
  } else if (dbResource) {
    // Provider API failed OR resource was never synced (just created): use DB data
    instance = {
      id: dbResource.id,
      pluginId: dbResource.pluginId,
      resourceTypeId: dbResource.resourceTypeId,
      accountId: dbResource.accountId,
      displayName: dbResource.displayName,
      fields: storedFields(dbResource.fieldsJson ?? {}),
      resolvedOutputs: storedOutputs(dbResource.outputsJson ?? {}),
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
    throw new NotFound({ error: "Resource not found" });
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
            await guardDriverConnection(driver, rtConnectionString, { accountId, organizationId });
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

            const text = (row: Record<string, unknown>, key: string) => String(row[key] ?? "");
            const tables = tableRows.map((t) => {
              const name = text(t, "table_name");
              const cols = columnRows.flatMap((col) =>
                text(col, "table_name") === name
                  ? [{ name: text(col, "column_name"), type: text(col, "data_type") }]
                  : [],
              );
              const pks = pkRows.flatMap((p) =>
                text(p, "table_name") === name ? [text(p, "column_name")] : [],
              );
              return { name, columns: cols, ...(pks.length > 0 ? { pkColumns: pks } : {}) };
            });

            enrichedInstance = {
              ...enrichedInstance,
              resolvedOutputs: {
                ...enrichedInstance.resolvedOutputs,
                __tables__: JSON.stringify(tables),
              },
            };
          } catch {
            /* introspection failed: still enable SQL editor */
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
      /* enrichment is best-effort: renderDetail still runs on the base resource */
    }
  }

  const detailSchema = client.renderDetail(enrichedInstance);

  // Inject sqlEditor if per-resource SQL driver is active but plugin didn't provide one
  const tablesJson = enrichedInstance.resolvedOutputs?.["__tables__"];
  const injectedTables: SqlTableMeta[] | undefined = tablesJson
    ? JSON.parse(tablesJson)
    : undefined;
  const finalSchema: DetailViewSchema =
    rtSqlDriver && sqlOk && !detailSchema.sqlEditor
      ? {
          ...detailSchema,
          sqlEditor: {
            connectionStringOutputKey: rtSqlDriver.connectionStringOutputKey,
            defaultQuery:
              "SELECT * FROM information_schema.tables WHERE table_schema = 'public' LIMIT 20;",
            ...(injectedTables ? { tables: injectedTables } : {}),
          },
        }
      : detailSchema;

  const peerPanes: Awaited<ReturnType<typeof buildPeerPanes>> = [];
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
    if (input.includePeerPanes) {
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
            ...(rt.iconKey ? { iconKey: rt.iconKey } : {}),
            showcase: showcaseFields(rt),
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
  // Only ship whole per-child field bags when the detail view actually renders
  // a child table for that type, otherwise it's wasted payload.
  const childTableTypeIds = new Set((finalSchema.childTables ?? []).map((t) => t.typeId));
  for (const result of childResults) {
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
        // A child table needs every field; a tile only what it can show.
        fields: childTableTypeIds.has(r.resourceTypeId)
          ? (r.fields ?? {})
          : pickShowcaseValues(
              r.fields,
              childTypes.find((t) => t.id === r.resourceTypeId)?.showcase ?? [],
            ),
      });
    }
  }

  const canDelete = !!client.deleteResource && resourceTypeDef?.supportsDelete !== false;
  const canEdit = !!client.updateResource && !!resourceTypeDef?.supportsUpdate;
  // `isFieldEditable` is the one definition of a resource type's writable
  // surface (plugin-base): the Edit modal filters with it, and the change
  // timeline's revert asks it whether a drifted field can be put back.
  const editableFields = canEdit
    ? (resourceTypeDef?.fields ?? []).flatMap((f) =>
        isFieldEditable(f)
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
  const isMongoDb = manifest.kvDriver?.browser === "documents";
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

  return {
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
    // A plugin that installs itself over SSH is never offered as a target of
    // its own installer (e.g. enrolling a Tailscale device into Tailscale).
    supportsSshInstall: (hasSshTerminal || !!sshHost) && !loadedPlugin.plugin.manifest.sshInstall,
    sshHost,
    sshPrivateHost,
    defaultSshUsername,
    containerId,
    databaseName,
    storageBucketName,
    supportsMetrics:
      ((resourceTypeDef?.supportsMetrics ?? false) && !!client.fetchMetricSeries) ||
      (resourceTypeDef?.peerIntegrations?.some((i) => i.exposeMetricsToParent) ?? false),
    // Sleep/wake eligibility: discovered from the plugin's lifecycle
    // declaration, never from provider names.
    schedulable: !!resourceTypeDef?.lifecycle && !!client.invokeAction,
  };
}

/**
 * Deleting something the orphan finder flags is a realized saving. Only for
 * the account's own plugin (a peer resource is not in our inventory), and
 * never awaited into the response: it reads billing, and the delete has
 * already succeeded whatever it finds. Never throws.
 */
export function captureDeletion(
  ctx: ResourceClient,
  input: {
    readonly organizationId: string;
    readonly userId: string | null;
    readonly pluginId: string;
    readonly resourceTypeId: string;
    readonly resourceId: string;
    readonly accountId: string;
  },
): Promise<void> {
  if (ctx.account.pluginId !== input.pluginId) return Promise.resolve();
  return keepAlive(
    captureDeletionSaving({
      organizationId: input.organizationId,
      accountId: input.accountId,
      resourceId: input.resourceId,
      resourceTypeId: input.resourceTypeId,
      pluginId: input.pluginId,
      source: "in_app",
      userId: input.userId,
      ctx: { client: ctx.client, plugin: ctx.plugin },
    }),
  );
}

export interface CreateRequest {
  readonly organizationId: string;
  readonly accountId: string;
  readonly pluginId: string;
  readonly resourceTypeId: string;
  readonly parentResourceId: string | undefined;
  /** The fields with reference-mode picker values flattened to their literal value. */
  readonly resolvedFields: Record<string, string>;
  readonly refFields: ReadonlyArray<{ fieldKey: string; ref: OutputRefValue }>;
}

/**
 * `POST /create` from the plugin call on, after the tag policy let it
 * through: create upstream, persist the row, then the secrets the plugin held
 * and returned, then the live output references.
 */
export async function createResource(ctx: ResourceClient, input: CreateRequest) {
  const createUpstream = ctx.client.createResource;
  if (!createUpstream) throw new BadRequest({ error: "Plugin does not support creation" });
  const { organizationId } = input;

  // What the plugin stores from inside this has no row to attach to until the upsert.
  const heldSecrets = holdSecretWrites();
  let createReturn;
  try {
    const create = createUpstream.bind(ctx.client);
    createReturn = await heldSecrets.run(() =>
      create(input.resourceTypeId, input.accountId, input.resolvedFields, input.parentResourceId),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Resource creation failed";
    throw new BadRequest({ error: message });
  }

  const {
    resource: created,
    warnings,
    credentialUpdates,
  } = normalizeResourceCreateResult(createReturn);

  // If the plugin minted sidecar credentials during creation (e.g. DO
  // auto-generating Spaces S3 keys on first bucket-create), merge them into
  // the account's encrypted credentials row, before persisting the resource
  // so the next ctx fetch for this account sees the new keys. A failure here
  // is non-fatal: the resource still got created upstream and the user can
  // edit the account to paste the keys manually.
  if (credentialUpdates && Object.keys(credentialUpdates).length > 0) {
    try {
      // Under the account's row lock, so the merge cannot race an OAuth
      // token refresh and write back a rotated-away refresh token.
      await updateAccountCredentials(input.accountId, organizationId, (existing) => ({
        ...existing,
        ...credentialUpdates,
      }));
    } catch (err) {
      console.error("[resource-detail] Failed to persist auto-minted credentials:", err);
      warnings.push({
        code: "do.credential-persist-failed",
        message: `Couldn't save auto-generated account credentials: ${err instanceof Error ? err.message : String(err)}. Edit the account to add them manually.`,
      });
    }
  }

  // Persist top-level (non-peer) resources to DB so the detail page can find
  // them without waiting for the next sync. Peer resources (e.g. k8s-pod on a
  // gcloud account) are not stored here since they aren't owned by the
  // account's native plugin.
  if (ctx.account.pluginId === input.pluginId) {
    // The resource row itself is non-critical: if the insert fails, the
    // detail page falls back to listResources. Log so regressions are visible.
    try {
      await upsertCreatedResource({
        organizationId,
        pluginId: input.pluginId,
        resourceTypeId: input.resourceTypeId,
        accountId: input.accountId,
        resource: created,
      });
    } catch (err) {
      console.error("[resource-detail] Failed to persist newly created resource:", err);
    }

    // Secret persistence is critical: plaintext create-time secrets only
    // exist in this response and can't be reconstructed by listResources. If
    // any write fails, surface the error so the caller knows the resource was
    // created upstream but its credentials weren't stored.
    try {
      await heldSecrets.flush();
      for (const state of created.secretStates ?? []) {
        if (state.resolution.kind !== "plaintext") continue;
        await setLiteralSecretState(created.id, state.fieldKey, state.resolution.value);
      }
    } catch (err) {
      console.error("[resource-detail] Failed to persist secret state for created resource:", err);
      // Not the error's text: a failed query's names its parameters, ciphertext included.
      throw new InternalServerError({
        error:
          `Resource ${created.displayName} was created but its credentials could not be stored. ` +
          `Delete the resource and retry, or set the missing fields manually.`,
      });
    }

    // Persist live output references for picker-in-reference-mode fields. The
    // secret_field_states row is the source of truth the reconciler reads;
    // the associations row is best-effort topology (its provider FK can fail
    // if the source resource hasn't been synced into this org yet).
    for (const { fieldKey, ref } of input.refFields) {
      try {
        await setOutputRefSecretState(
          created.id,
          fieldKey,
          {
            pluginId: ref.pluginId,
            resourceTypeId: ref.resourceTypeId,
            resourceId: ref.resourceId,
            accountId: ref.accountId,
            outputKey: ref.outputKey,
          },
          ref.value,
        );
        // Best-effort topology row: provider FK may not exist yet.
        try {
          await db
            .insert(associations)
            .values({
              id: uuidv4(),
              consumerResourceId: created.id,
              consumerFieldKey: fieldKey,
              providerResourceId: ref.resourceId,
              providerOutputKey: ref.outputKey,
              syncVersion: nextAssociationSyncVersion(organizationId),
            })
            .onConflictDoUpdate({
              target: [associations.consumerResourceId, associations.consumerFieldKey],
              set: {
                providerResourceId: ref.resourceId,
                providerOutputKey: ref.outputKey,
                syncVersion: nextAssociationSyncVersion(organizationId),
                updatedAt: new Date(),
              },
            });
        } catch (assocErr) {
          console.warn(
            "[resource-detail] Skipped association topology row (provider not yet synced):",
            assocErr instanceof Error ? assocErr.message : assocErr,
          );
        }
      } catch (err) {
        console.error("[resource-detail] Failed to persist output reference:", err);
      }
    }
  } else {
    // A peer resource gets no row here, and its secrets go on a row of their own.
    try {
      await heldSecrets.flush();
    } catch (err) {
      console.error("[resource-detail] Failed to persist a peer resource's secret:", err);
      warnings.push({
        code: "secret-persist-failed",
        message: `${created.displayName} was created but its credentials could not be stored.`,
      });
    }
  }

  return { id: created.id, displayName: created.displayName, warnings };
}

export interface UpdateRequest {
  readonly organizationId: string;
  readonly userId: string | undefined;
  readonly accountId: string;
  readonly pluginId: string;
  readonly resourceTypeId: string;
  readonly resourceId: string;
  readonly fields: Record<string, string>;
}

/**
 * `POST /update` from the plugin call on, after the account check, the id's
 * account scoping and the change freeze let it through.
 */
export async function updateResource(ctx: ResourceClient, input: UpdateRequest) {
  const updateUpstream = ctx.client.updateResource;
  if (!updateUpstream) throw new BadRequest({ error: "Plugin does not support updates" });
  const { organizationId } = input;

  // The stored fields before the edit: a resize to a smaller size is a
  // realized saving, and the mirror below overwrites the old size.
  // Best-effort: a failed read costs the saving, never the edit.
  let prior: { fieldsJson: Record<string, unknown>; externalId: string | null } | undefined;
  if (ctx.account.pluginId === input.pluginId) {
    try {
      [prior] = await db
        .select({ fieldsJson: resources.fieldsJson, externalId: resources.externalId })
        .from(resources)
        .where(
          and(
            eq(resources.id, input.resourceId),
            eq(resources.organizationId, organizationId),
            eq(resources.accountId, input.accountId),
          ),
        )
        .limit(1);
    } catch (err) {
      console.warn("[resource-detail] Could not read fields before update:", err);
    }
  }

  let updated;
  try {
    updated = await updateUpstream.call(
      ctx.client,
      input.resourceTypeId,
      input.resourceId,
      input.accountId,
      input.fields,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Resource update failed";
    throw new BadRequest({ error: message });
  }

  // A provider that makes each edit a new version answers with a new id, which every
  // later edit has to be addressed to. The same scoping as the check above applies: an
  // id outside this account is a plugin bug, and it must not move a row or reach a client.
  const followsNewId = updated.id !== input.resourceId;
  const nextId =
    followsNewId && resourceIdBelongsToAccount(updated.id, input.accountId)
      ? updated.id
      : input.resourceId;
  if (followsNewId && nextId === input.resourceId) {
    console.error(
      `[resource-detail] ${input.pluginId} answered an edit with a resource id outside the account`,
    );
  }

  // Every applied edit lands in the audit trail: resource updates carry
  // real provider mutations (a resize restarts the machine).
  void logAudit({
    organizationId,
    userId: input.userId,
    action: "resource.update",
    entityType: "resource",
    entityId: input.resourceId,
    metadata: {
      pluginId: input.pluginId,
      resourceTypeId: input.resourceTypeId,
      // Keys only: edited values can include write-only password fields,
      // which must never land in the audit table.
      fieldKeys: Object.keys(input.fields ?? {}),
      ...(nextId !== input.resourceId ? { newResourceId: nextId } : {}),
    },
  });

  // Mirror the refreshed fields/displayName into the DB so the next page
  // load sees the new values without waiting for a sync cycle. Peer-managed
  // resources skip this: they aren't owned by the account's native plugin.
  // The fields and outputs merge into the stored ones, as the sync does: a
  // field the plugin's read after the edit could not fill keeps its value
  // rather than vanish until the next poll. A field cleared on purpose is an
  // explicit value.
  if (ctx.account.pluginId === input.pluginId) {
    try {
      if (nextId !== input.resourceId) {
        // The new id has no row of its own yet, so the old row's fields go with it.
        await supersedeResource({
          organizationId,
          pluginId: input.pluginId,
          resourceTypeId: input.resourceTypeId,
          accountId: input.accountId,
          previousId: input.resourceId,
          resource: {
            ...updated,
            fields: { ...storedFields(prior?.fieldsJson ?? {}), ...updated.fields },
          },
        });
      } else {
        await db
          .update(resources)
          .set({
            displayName: updated.displayName,
            fieldsJson: sql`COALESCE(${resources.fieldsJson}, '{}'::jsonb) || ${JSON.stringify(updated.fields ?? {})}::jsonb`,
            outputsJson: sql`COALESCE(${resources.outputsJson}, '{}'::jsonb) || ${JSON.stringify(updated.resolvedOutputs ?? {})}::jsonb`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(resources.id, input.resourceId),
              eq(resources.organizationId, organizationId),
              eq(resources.accountId, input.accountId),
            ),
          );
      }
    } catch (err) {
      console.error("[resource-detail] Failed to persist updated resource:", err);
    }
  }

  // A downsize of a right-sizing type (the Oversized section's Apply button
  // rides this route) is recorded as a saving. Not awaited: it prices sizes
  // against the provider's catalogue, and the edit has already succeeded.
  if (prior) {
    void keepAlive(
      captureResizeSaving({
        organizationId,
        accountId: input.accountId,
        resourceId: input.resourceId,
        resourceTypeId: input.resourceTypeId,
        pluginId: input.pluginId,
        source: "in_app",
        priorFields: prior.fieldsJson,
        nextFields: { ...(prior.fieldsJson ?? {}), ...input.fields, ...(updated.fields ?? {}) },
        displayName: updated.displayName,
        externalId: prior.externalId ?? null,
        userId: input.userId ?? null,
        ctx: { client: ctx.client, plugin: ctx.plugin },
      }),
    );
  }

  return { id: nextId, displayName: updated.displayName, fields: updated.fields ?? {} };
}

export interface PickerRequest {
  readonly organizationId: string;
  readonly sources: ReadonlyArray<{ pluginId: string; resourceTypeId: string; outputKey: string }>;
  readonly accountId: string;
  readonly regionHint: string | undefined;
  /**
   * When true, search every account in the org whose plugin matches a
   * source: used by reference-mode pickers (e.g. DNS content) where the
   * target resource usually lives in a different account/provider.
   */
  readonly crossAccount: boolean | undefined;
}

/** `POST /picker-resources`: the options of a resource-picker field. */
export async function pickerResources(input: PickerRequest) {
  const { organizationId } = input;
  const results: Array<{
    id: string;
    label: string;
    pluginId: string;
    resourceTypeId: string;
    accountId: string;
    outputKey: string;
    outputValue: string;
  }> = [];

  // Resolve the set of (accountId) to search per source. Single-account mode
  // only ever uses the creating account; cross-account mode fans out to all
  // org accounts whose pluginId matches the source.
  let accountsByPlugin: Map<string, string[]> | null = null;
  const accountNames = new Map<string, string>();
  if (input.crossAccount) {
    accountsByPlugin = new Map();
    const rows = await db
      .select({ id: accounts.id, pluginId: accounts.pluginId, displayName: accounts.displayName })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
    for (const row of rows) {
      const list = accountsByPlugin.get(row.pluginId) ?? [];
      list.push(row.id);
      accountsByPlugin.set(row.pluginId, list);
      accountNames.set(row.id, row.displayName);
    }
  }

  for (const source of input.sources) {
    const targetAccountIds = accountsByPlugin
      ? (accountsByPlugin.get(source.pluginId) ?? [])
      : [input.accountId];

    for (const acctId of targetAccountIds) {
      try {
        const ctx = await getClientForAccount(acctId, organizationId);
        if (!ctx || ctx.plugin.manifest.id !== source.pluginId) continue;

        const listed = await ctx.client.listResources(
          source.resourceTypeId,
          acctId,
          input.regionHint ? { regionHint: input.regionHint } : undefined,
        );
        for (const resource of listed) {
          try {
            // Prefer the value the lister already populated: avoids an N+1
            // re-list when resolveOutput would just re-fetch the same data.
            const preResolved = resource.resolvedOutputs[source.outputKey];
            const outputValue =
              preResolved != null && String(preResolved) !== ""
                ? String(preResolved)
                : await ctx.client.resolveOutput(
                    source.resourceTypeId,
                    resource.id,
                    source.outputKey,
                    acctId,
                  );
            if (!outputValue) continue;
            results.push({
              id: resource.id,
              label: accountsByPlugin
                ? `${resource.displayName} · ${accountNames.get(acctId) ?? acctId}`
                : resource.displayName,
              pluginId: source.pluginId,
              resourceTypeId: source.resourceTypeId,
              accountId: acctId,
              outputKey: source.outputKey,
              outputValue,
            });
          } catch {
            // Skip resources where output can't be resolved
          }
        }
      } catch {
        // Skip accounts/sources that fail
      }
    }
  }

  return results;
}

export interface CostEstimateRequest {
  readonly organizationId: string;
  readonly accountId: string;
  readonly resourceTypeId: string;
  readonly fields: Record<string, string> | undefined;
  readonly resourceId: string | undefined;
  readonly pluginId: string | undefined;
  readonly parentResourceId: string | undefined;
}

/**
 * `POST /cost-estimate`: monthly cost of a configuration, with its carbon.
 *
 * One route for all three questions the UI asks: what would this create cost
 * (`fields`), what does this resource cost (`resourceId`), and what would this
 * edit cost (both; `fields` is merged over the resource's stored fields, so
 * the caller sends only what changed).
 *
 * A peer-resource client (`pluginId` + `parentResourceId`) is resolved here
 * rather than in server-core, because only the web host has the peer
 * plumbing; the ordinary account path delegates so the digest and this route
 * cannot drift in how they merge fields.
 */
export async function costEstimate(input: CostEstimateRequest) {
  const { organizationId } = input;
  // Carbon rides the same response as the price, so every surface that shows
  // one can show the other without a second round trip. A peer resource's
  // configuration has no carbon declaration to read.
  const carbonFor = async (): Promise<ResourceCarbonEstimate | null> => {
    if (input.parentResourceId) return null;
    try {
      if (input.resourceId) {
        return await getResourceCarbon(organizationId, {
          accountId: input.accountId,
          resourceTypeId: input.resourceTypeId,
          resourceId: input.resourceId,
          fields: input.fields,
        });
      }
      const [account] = await db
        .select({ pluginId: accounts.pluginId })
        .from(accounts)
        .where(and(eq(accounts.id, input.accountId), eq(accounts.organizationId, organizationId)))
        .limit(1);
      if (!account) return null;
      const footprint = await getConfigCarbon(organizationId, {
        accountId: input.accountId,
        pluginId: input.pluginId ?? account.pluginId,
        resourceTypeId: input.resourceTypeId,
        fields: input.fields ?? {},
      });
      return footprint
        ? { ...resourceCarbonEstimate(null), inScope: true, estimate: footprint }
        : null;
    } catch {
      // Like the price: a catalogue that fails costs the caller its estimate,
      // never its request.
      return null;
    }
  };

  if (!input.pluginId) {
    const [estimate, carbon] = await Promise.all([
      estimateResourceCost(organizationId, {
        accountId: input.accountId,
        resourceTypeId: input.resourceTypeId,
        fields: input.fields,
        resourceId: input.resourceId,
      }),
      carbonFor(),
    ]);
    return { estimate, carbon };
  }

  const ctx = await getClientForResource(
    input.pluginId,
    input.accountId,
    organizationId,
    input.parentResourceId,
  );
  if (!ctx) throw new NotFound({ error: ACCOUNT_OR_PEER_NOT_FOUND });
  const [estimate, carbon] = await Promise.all([
    ctx.client.estimateCost
      ? ctx.client.estimateCost(input.resourceTypeId, input.fields ?? {}).catch(() => null)
      : Promise.resolve(null),
    carbonFor(),
  ]);
  return { estimate: estimate ?? null, carbon };
}

export interface PeerPanesRequest {
  readonly organizationId: string;
  readonly pluginId: string;
  readonly resourceTypeId: string;
  readonly accountId: string;
  readonly resourceId: string;
  readonly parentResourceId: string | undefined;
}

/** `POST /:pluginId/:typeId/peer-panes`: the peer tabs, fetched when one is opened. */
export async function peerPanes(input: PeerPanesRequest) {
  const { organizationId, pluginId, resourceTypeId, accountId, resourceId, parentResourceId } =
    input;
  const ctx = parentResourceId
    ? await getClientForResource(pluginId, accountId, organizationId, parentResourceId)
    : await getClientForAccount(accountId, organizationId);
  if (!ctx) throw new NotFound({ error: "Account not found" });

  const resourceTypeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
  if (!resourceTypeDef?.peerIntegrations?.length) return [];

  // Apply the same requiresFields/showWhen filter the eager detail route uses,
  // so we never surface peer tabs that the detail payload hid. Mirror the
  // detail route's resolution order: try the live provider first, then fall
  // back to the persisted DB fields so transient provider failures or
  // just-created resources don't make tabs disappear that the initial detail
  // payload already exposed as stubs.
  let parentFields: Record<string, unknown> | undefined;
  const liveParent = await ctx.client
    .getResource(resourceTypeId, resourceId, accountId)
    .catch(() => null);
  if (liveParent?.fields) {
    parentFields = liveParent.fields;
  } else if (!parentResourceId) {
    const [dbResource] = await db
      .select({ fieldsJson: resources.fieldsJson })
      .from(resources)
      .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
      .limit(1);
    if (dbResource?.fieldsJson) {
      parentFields = dbResource.fieldsJson;
    }
  }
  const visibleIntegrations = filterVisiblePeerIntegrations(
    resourceTypeDef.peerIntegrations,
    parentFields,
  );
  if (!visibleIntegrations.length) return [];

  return buildPeerPanes(
    ctx.client,
    ctx.plugin,
    visibleIntegrations,
    resourceTypeId,
    resourceId,
    accountId,
    organizationId,
  );
}

export interface MetricsRequest {
  readonly organizationId: string;
  readonly pluginId: string;
  readonly resourceTypeId: string;
  readonly accountId: string;
  readonly resourceId: string;
  readonly startMs: number | undefined;
  readonly endMs: number | undefined;
  readonly parentResourceId: string | undefined;
}

/**
 * `POST /:pluginId/:typeId/metrics`: a resource's metric series. History
 * comes from ClickHouse (written by the poller); only resources pinned on
 * some dashboard accumulate points. With no history, the series are fetched
 * live from the provider via the plugin's `fetchMetricSeries`, so an unpinned
 * resource still charts whatever the provider can serve on demand.
 */
export async function resourceMetrics(input: MetricsRequest) {
  const { organizationId, resourceId, accountId } = input;
  const toMs = input.endMs ?? Date.now();
  const fromMs = input.startMs ?? toMs - 60 * 60 * 1000;
  const series = await getMetricRange(organizationId, resourceId, fromMs, toMs);
  if (series.length > 0) return { series };

  // Live fallback. Failures degrade to the empty history rather than a 500:
  // "no data" is an answer, a dead provider shouldn't take out the chart pane.
  try {
    const ctx = await getClientForResource(
      input.pluginId,
      accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx?.client.fetchMetricSeries) return { series };
    const live = await ctx.client.fetchMetricSeries(input.resourceTypeId, resourceId, accountId, {
      startMs: fromMs,
      endMs: toMs,
    });
    return { series: live };
  } catch {
    return { series };
  }
}

/**
 * `POST /:pluginId/:typeId/export-terraform`: HCL for one stored resource
 * plus its direct children (e.g. a zone's DNS records). Mapping runs from
 * persisted state: no provider API calls.
 */
export async function exportResourceTerraform(input: {
  readonly organizationId: string;
  readonly pluginId: string;
  readonly resourceId: string;
  readonly accountId: string;
}) {
  const loaded = await getPlugin(input.pluginId);
  if (!loaded) throw new NotFound({ error: "Plugin not found" });
  if (!loaded.plugin.terraformExport) {
    throw new BadRequest({ error: "Plugin does not support Terraform export" });
  }
  const rows = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
      externalId: resources.externalId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      parentResourceId: resources.parentResourceId,
    })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, input.organizationId),
        eq(resources.accountId, input.accountId),
        isNull(resources.deletedAt),
        or(eq(resources.id, input.resourceId), eq(resources.parentResourceId, input.resourceId)),
      ),
    );
  if (!rows.some((r) => r.id === input.resourceId)) {
    throw new NotFound({ error: "Resource not found" });
  }
  // The requested resource's block leads the file; children follow.
  const ordered = [...rows].sort((a, b) =>
    a.id === input.resourceId ? -1 : b.id === input.resourceId ? 1 : a.id.localeCompare(b.id),
  );
  return exportStoredResourcesToTerraform(ordered);
}
