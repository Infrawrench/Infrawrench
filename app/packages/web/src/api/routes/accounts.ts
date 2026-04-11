import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq, and, isNull, isNotNull, notInArray, inArray, lt } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, resources } from "../../db/schema";
import { encrypt, decrypt } from "../../services/encryption";
import { loadPlugins, getPlugin } from "../../plugins/loader";
import { buildPluginHostServices } from "../../services/host-services";
import type { AuthSession } from "../auth-middleware";
import type { ResourceInstance } from "@infrawrench/plugin-base";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/plugins — list available plugins */
app.get("/plugins", async (c) => {
  const plugins = await loadPlugins();
  return c.json(
    plugins.map((p) => ({
      id: p.plugin.manifest.id,
      displayName: p.plugin.manifest.displayName,
      logoSvg: p.plugin.manifest.logoSvg,
      credentialFields: p.plugin.manifest.credentialFields.map((f) => ({
        key: f.key,
        label: f.label,
        description: f.description,
        placeholder: f.placeholder,
        sensitive: f.sensitive,
        multiline: f.multiline,
        defaultValue: f.defaultValue,
      })),
    })),
  );
});

/** GET /api/accounts — list accounts */
app.get("/", async (c) => {
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      displayName: accounts.displayName,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  return c.json(rows);
});

/** POST /api/accounts — create an account */
app.post("/", async (c) => {
  const organizationId = c.get("organizationId");
  const { pluginId, displayName, credentials } = await c.req.json<{
    pluginId: string;
    displayName: string;
    credentials: Record<string, string>;
  }>();

  const { ciphertext, iv } = await encrypt(JSON.stringify(credentials));
  const id = uuid();
  await db.insert(accounts).values({
    id,
    organizationId,
    pluginId,
    displayName,
    encryptedCredentials: ciphertext,
    credentialsIv: iv,
  });

  // Sync resources before returning so the UI has data immediately
  try {
    await syncAccountResources(id, organizationId);
  } catch (e) {
    console.error(`[createAccount] Sync failed for ${id}:`, e);
  }

  return c.json({ id });
});

/** DELETE /api/accounts/:id */
app.delete("/:id", async (c) => {
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  await db.delete(accounts).where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  return c.json({ ok: true });
});

/** GET /api/accounts/:id/credentials — get decrypted credentials */
app.get("/:id/credentials", async (c) => {
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  const [row] = await db
    .select({ encryptedCredentials: accounts.encryptedCredentials, credentialsIv: accounts.credentialsIv })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!row) return c.json({ error: "Account not found" }, 404);
  const plaintext = await decrypt(row.encryptedCredentials, row.credentialsIv);
  return c.json(JSON.parse(plaintext));
});

/** GET /api/accounts/:id/resources — list resources for account */
app.get("/:id/resources", async (c) => {
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  const topLevelOnly = c.req.query("topLevelOnly") === "true";

  const conditions = [
    eq(resources.accountId, accountId),
    eq(resources.organizationId, organizationId),
    isNull(resources.deletedAt),
  ];
  if (topLevelOnly) conditions.push(isNull(resources.parentResourceId));

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
    .where(and(...conditions));
  return c.json(rows);
});

/** POST /api/accounts/:id/sync — sync resources from plugin API */
app.post("/:id/sync", async (c) => {
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  const count = await syncAccountResources(accountId, organizationId);
  return c.json({ synced: count });
});

/** GET /api/accounts/:id/detail — full account detail for the account page */
app.get("/:id/detail", async (c) => {
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!account) return c.json({ error: "Account not found" }, 404);

  // Sync resources from the provider so data is always fresh
  try {
    await syncAccountResources(accountId, organizationId);
  } catch {
    // Non-critical — show whatever we have in the DB
  }

  const resourceRows = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
      externalId: resources.externalId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      parentResourceId: resources.parentResourceId,
    })
    .from(resources)
    .where(and(eq(resources.accountId, accountId), eq(resources.organizationId, organizationId), isNull(resources.deletedAt), isNull(resources.parentResourceId)));

  const plugin = await getPlugin(account.pluginId);
  const resourceTypes = plugin?.plugin.resourceTypes.map((rt) => ({
    id: rt.id,
    displayName: rt.displayName,
    pluralDisplayName: rt.pluralDisplayName,
    parentTypeId: rt.parentTypeId,
    supportsCreate: rt.supportsCreate ?? false,
  })) ?? [];

  return c.json({
    account: {
      id: account.id,
      pluginId: account.pluginId,
      displayName: account.displayName,
    },
    resources: resourceRows,
    resourceTypes,
    pluginDisplayName: plugin?.plugin.manifest.displayName ?? "",
    pluginLogoSvg: plugin?.plugin.manifest.logoSvg ?? "",
  });
});

export async function syncAccountResources(accountId: string, organizationId: string): Promise<number> {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!account) throw new Error("Account not found");

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) throw new Error(`Plugin "${account.pluginId}" not loaded`);

  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);

  // Fetch all resource types in parallel (like desktop).
  // Track which resource types succeeded so we only soft-delete resources
  // for types that were actually fetched — transient API failures (e.g. GCP
  // service disabled, 500, permission denied) should not wipe existing data.
  const results = await Promise.allSettled(
    loaded.plugin.resourceTypes.map((typeDef) => client.listResources(typeDef.id, accountId)),
  );
  const allResources: ResourceInstance[] = [];
  const succeededTypeIds = new Set<string>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      allResources.push(...r.value);
      succeededTypeIds.add(loaded.plugin.resourceTypes[i]!.id);
    }
  }

  await Promise.all(
    allResources.map((r) =>
      db
        .insert(resources)
        .values({
          id: r.id,
          organizationId,
          pluginId: r.pluginId,
          resourceTypeId: r.resourceTypeId,
          accountId,
          displayName: r.displayName,
          externalId: r.externalId ?? null,
          fieldsJson: r.fields ?? {},
          outputsJson: r.resolvedOutputs ?? {},
          parentResourceId: r.parentResourceId ?? null,
          lastSyncedAt: new Date(),
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: resources.id,
          set: {
            displayName: r.displayName,
            fieldsJson: r.fields ?? {},
            outputsJson: r.resolvedOutputs ?? {},
            parentResourceId: r.parentResourceId ?? null,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
        }),
    ),
  );

  // Soft-delete resources that no longer exist upstream.
  // Only delete resources whose resource type was successfully fetched — if a
  // type's API call failed, we keep existing resources to avoid flickering.
  // Skip resources that have never been synced (lastSyncedAt IS NULL) — these
  // were locally created and the provider may not list them yet (e.g. VM still
  // provisioning). They'll become eligible for cleanup once a future sync
  // confirms them (sets lastSyncedAt).
  const liveIds = allResources.map((r) => r.id);
  const succeededTypeIdsArray = [...succeededTypeIds];
  if (succeededTypeIdsArray.length > 0) {
    const deleteConditions = [
      eq(resources.accountId, accountId),
      eq(resources.organizationId, organizationId),
      isNull(resources.deletedAt),
      isNotNull(resources.lastSyncedAt),
      inArray(resources.resourceTypeId, succeededTypeIdsArray),
    ];
    if (liveIds.length > 0) {
      deleteConditions.push(notInArray(resources.id, liveIds));
    }
    await db
      .update(resources)
      .set({ deletedAt: new Date() })
      .where(and(...deleteConditions));
  }

  // Clean up locally-created resources that were never confirmed by the
  // provider. These have lastSyncedAt IS NULL (the create endpoint doesn't
  // set it). After a grace period (5 minutes), if the provider still doesn't
  // list them, they're ghost records — e.g. the VM was deleted externally
  // before a sync could confirm it, or the provider uses a different ID
  // format than createResource returned.
  // Only clean up types that were successfully fetched.
  if (succeededTypeIdsArray.length > 0) {
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
    const staleConditions = [
      eq(resources.accountId, accountId),
      eq(resources.organizationId, organizationId),
      isNull(resources.deletedAt),
      isNull(resources.lastSyncedAt),
      lt(resources.createdAt, staleThreshold),
      inArray(resources.resourceTypeId, succeededTypeIdsArray),
    ];
    if (liveIds.length > 0) {
      staleConditions.push(notInArray(resources.id, liveIds));
    }
    await db
      .update(resources)
      .set({ deletedAt: new Date() })
      .where(and(...staleConditions));
  }

  return allResources.length;
}

export { app as accountRoutes };
