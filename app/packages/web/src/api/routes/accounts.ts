import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, resources } from "../../db/schema";
import { encrypt, decrypt, buildAad } from "../../services/encryption";
import { loadPlugins, getPlugin } from "../../plugins/loader";
import { syncAccountResources, syncAccountResourceType } from "../../services/sync-resources";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/plugins — list available plugins */
app.get("/plugins", async (c) => {
  requirePermission(c, "accounts:read");
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
  requirePermission(c, "accounts:read");
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
  requirePermission(c, "accounts:write");
  const organizationId = c.get("organizationId");
  const { pluginId, displayName, credentials } = await c.req.json<{
    pluginId: string;
    displayName: string;
    credentials: Record<string, string>;
  }>();

  const id = uuid();
  const { ciphertext, iv } = await encrypt(
    JSON.stringify(credentials),
    buildAad("account", id, "credentials"),
  );
  await db.insert(accounts).values({
    id,
    organizationId,
    pluginId,
    displayName,
    encryptedCredentials: ciphertext,
    credentialsIv: iv,
  });

  // Sync resources before returning so the UI has data immediately. If the
  // sync itself blows up we still return the freshly-created account row, but
  // we surface the failure to the caller so they can render a warning.
  let syncError: { message: string } | undefined;
  try {
    await syncAccountResources(id, organizationId);
  } catch (e) {
    console.error(`[createAccount] Sync failed for ${id}:`, e);
    syncError = { message: e instanceof Error ? e.message : String(e) };
  }

  return c.json({ id, syncError });
});

/** DELETE /api/accounts/:id */
app.delete("/:id", async (c) => {
  requirePermission(c, "accounts:delete");
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  await db
    .delete(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  return c.json({ ok: true });
});

/** PATCH /api/accounts/:id — rename account */
app.patch("/:id", async (c) => {
  requirePermission(c, "accounts:write");
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  const { displayName } = await c.req.json<{ displayName: string }>();

  if (!displayName || typeof displayName !== "string") {
    return c.json({ error: "displayName is required" }, 400);
  }

  const [updated] = await db
    .update(accounts)
    .set({ displayName })
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .returning({ id: accounts.id, displayName: accounts.displayName });

  if (!updated) return c.json({ error: "Account not found" }, 404);
  return c.json(updated);
});

/** GET /api/accounts/:id/credentials — get decrypted credentials */
app.get("/:id/credentials", async (c) => {
  requirePermission(c, "secrets:read");
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  const [row] = await db
    .select({
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!row) return c.json({ error: "Account not found" }, 404);
  const plaintext = await decrypt(
    row.encryptedCredentials,
    row.credentialsIv,
    buildAad("account", accountId, "credentials"),
  );
  return c.json(JSON.parse(plaintext));
});

/** GET /api/accounts/:id/resources — list resources for account */
app.get("/:id/resources", async (c) => {
  requirePermission(c, "resources:read");
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
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  const result = await syncAccountResources(accountId, organizationId);
  return c.json({ synced: result.resourceCount });
});

/** GET /api/accounts/:id/detail — account metadata + resource types (no resources, no sync) */
app.get("/:id/detail", async (c) => {
  requirePermission(c, "accounts:read");
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!account) return c.json({ error: "Account not found" }, 404);

  const plugin = await getPlugin(account.pluginId);
  const resourceTypes =
    plugin?.plugin.resourceTypes.map((rt) => ({
      id: rt.id,
      displayName: rt.displayName,
      pluralDisplayName: rt.pluralDisplayName,
      parentTypeId: rt.parentTypeId,
      supportsCreate: rt.supportsCreate ?? false,
      ...(rt.attachTargets ? { attachTargets: rt.attachTargets } : {}),
    })) ?? [];

  return c.json({
    account: {
      id: account.id,
      pluginId: account.pluginId,
      displayName: account.displayName,
    },
    resourceTypes,
    pluginDisplayName: plugin?.plugin.manifest.displayName ?? "",
    pluginLogoSvg: plugin?.plugin.manifest.logoSvg ?? "",
  });
});

/** POST /api/accounts/:id/sync-type/:typeId — sync a single resource type and return its resources */
app.post("/:id/sync-type/:typeId", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  const typeId = c.req.param("typeId");

  try {
    const fetched = await syncAccountResourceType(accountId, organizationId, typeId);
    return c.json(
      fetched.map((r) => ({
        id: r.id,
        pluginId: r.pluginId,
        resourceTypeId: r.resourceTypeId,
        displayName: r.displayName,
        externalId: r.externalId ?? null,
        fieldsJson: r.fields ?? {},
        outputsJson: r.resolvedOutputs ?? {},
        parentResourceId: r.parentResourceId ?? null,
      })),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sync failed";
    if (message === "Account not found") return c.json({ error: message }, 404);
    if (message.includes("not found")) return c.json({ error: message }, 404);
    if (message.includes("not loaded")) return c.json({ error: message }, 500);
    return c.json({ error: message }, 500);
  }
});

export { app as accountRoutes };
