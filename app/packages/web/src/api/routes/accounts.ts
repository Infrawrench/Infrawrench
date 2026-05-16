import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, bastionVms, resources } from "../../db/schema";
import { refreshAllowlistById } from "@infrawrench/server-core/bastion/registry";
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
        regions: f.regions,
        optional: f.optional,
        accountReference: f.accountReference,
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
      bastionId: accounts.bastionId,
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
  const { pluginId, displayName, credentials, bastionId } = await c.req.json<{
    pluginId: string;
    displayName: string;
    credentials: Record<string, string>;
    bastionId?: string | null;
  }>();

  // Verify the bastion (if any) belongs to this org — never trust the client.
  let validatedBastionId: string | null = null;
  if (bastionId) {
    const [b] = await db
      .select({ id: bastionVms.id })
      .from(bastionVms)
      .where(and(eq(bastionVms.id, bastionId), eq(bastionVms.organizationId, organizationId)))
      .limit(1);
    if (!b) return c.json({ error: "Bastion not found" }, 400);
    validatedBastionId = b.id;
  }

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
    bastionId: validatedBastionId,
  });

  // If the new account is bound to a bastion that's currently connected, push
  // the refreshed destination allowlist so the agent immediately starts
  // accepting traffic to this plugin's cloud APIs.
  if (validatedBastionId) {
    void refreshAllowlistById(validatedBastionId).catch(() => {});
  }

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

/** PATCH /api/accounts/:id — rename account or change bastion binding. */
app.patch("/:id", async (c) => {
  requirePermission(c, "accounts:write");
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("id");
  const body = await c.req.json<{
    displayName?: string;
    /** Pass `null` to unbind, a uuid to bind, or omit the field to leave unchanged. */
    bastionId?: string | null;
  }>();

  const updates: { displayName?: string; bastionId?: string | null } = {};
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string" || !body.displayName.trim()) {
      return c.json({ error: "displayName is required" }, 400);
    }
    updates.displayName = body.displayName;
  }
  let oldBastionId: string | null = null;
  if (body.bastionId !== undefined) {
    if (body.bastionId === null) {
      updates.bastionId = null;
    } else {
      const [b] = await db
        .select({ id: bastionVms.id })
        .from(bastionVms)
        .where(
          and(eq(bastionVms.id, body.bastionId), eq(bastionVms.organizationId, organizationId)),
        )
        .limit(1);
      if (!b) return c.json({ error: "Bastion not found" }, 400);
      updates.bastionId = b.id;
    }
    // Look up the previous bastionId so we can refresh both allowlists.
    const [existing] = await db
      .select({ bastionId: accounts.bastionId })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
      .limit(1);
    oldBastionId = existing?.bastionId ?? null;
  }
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  const [updated] = await db
    .update(accounts)
    .set(updates)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .returning({
      id: accounts.id,
      displayName: accounts.displayName,
      bastionId: accounts.bastionId,
    });

  if (!updated) return c.json({ error: "Account not found" }, 404);
  if (body.bastionId !== undefined) {
    if (oldBastionId && oldBastionId !== updates.bastionId) {
      void refreshAllowlistById(oldBastionId).catch(() => {});
    }
    if (updates.bastionId) {
      void refreshAllowlistById(updates.bastionId).catch(() => {});
    }
  }
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
