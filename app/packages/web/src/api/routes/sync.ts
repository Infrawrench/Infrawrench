import { Hono } from "hono";
import { eq, gt, and, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { accounts, resources, dashboards, dashboardPins, associations } from "../../db/schema";
import { authenticateApiRequest, requireScope } from "../../auth/api-auth";
import { encrypt, buildAad } from "../../services/encryption";
import { logAudit } from "../../services/audit";

const app = new Hono();

const accountPushSchema = z.object({
  id: z.string().min(1),
  pluginId: z.string().min(1),
  displayName: z.string(),
  credentials: z.record(z.string(), z.string()),
  updatedAt: z.string(),
  deletedAt: z.string().nullish(),
});

const resourcePushSchema = z.object({
  id: z.string().min(1),
  pluginId: z.string().min(1),
  resourceTypeId: z.string().min(1),
  accountId: z.string().min(1),
  displayName: z.string(),
  externalId: z.string().nullish(),
  fieldsJson: z.record(z.unknown()),
  outputsJson: z.record(z.unknown()),
  parentResourceId: z.string().nullish(),
  updatedAt: z.string(),
  deletedAt: z.string().nullish(),
});

const dashboardPushSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  isDefault: z.boolean(),
  updatedAt: z.string(),
  deletedAt: z.string().nullish(),
});

const pushBodySchema = z.object({
  accounts: z.array(accountPushSchema).optional(),
  resources: z.array(resourcePushSchema).optional(),
  dashboards: z.array(dashboardPushSchema).optional(),
});

/** POST /api/v1/sync/pull */
app.post("/pull", async (c) => {
  const auth = await authenticateApiRequest(c.req.raw);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  requireScope(auth, "resources:read");

  const { lastSyncVersion } = await c.req.json<{ lastSyncVersion: number }>();
  const orgId = auth.organizationId;

  const [accountRows, resourceRows, dashboardRows, pinRows, assocRows] = await Promise.all([
    db
      .select({
        id: accounts.id,
        pluginId: accounts.pluginId,
        displayName: accounts.displayName,
        encryptedCredentials: accounts.encryptedCredentials,
        credentialsIv: accounts.credentialsIv,
        syncVersion: accounts.syncVersion,
        deletedAt: accounts.deletedAt,
        updatedAt: accounts.updatedAt,
      })
      .from(accounts)
      .where(and(eq(accounts.organizationId, orgId), gt(accounts.syncVersion, lastSyncVersion))),
    db
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
        syncVersion: resources.syncVersion,
        deletedAt: resources.deletedAt,
        updatedAt: resources.updatedAt,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, orgId), gt(resources.syncVersion, lastSyncVersion))),
    db
      .select({
        id: dashboards.id,
        name: dashboards.name,
        isDefault: dashboards.isDefault,
        syncVersion: dashboards.syncVersion,
        deletedAt: dashboards.deletedAt,
        updatedAt: dashboards.updatedAt,
      })
      .from(dashboards)
      .where(
        and(eq(dashboards.organizationId, orgId), gt(dashboards.syncVersion, lastSyncVersion)),
      ),
    db.select().from(dashboardPins).where(gt(dashboardPins.syncVersion, lastSyncVersion)),
    db.select().from(associations).where(gt(associations.syncVersion, lastSyncVersion)),
  ]);

  return c.json({
    accounts: accountRows,
    resources: resourceRows,
    dashboards: dashboardRows,
    dashboardPins: pinRows,
    associations: assocRows,
  });
});

/** POST /api/v1/sync/push */
app.post("/push", async (c) => {
  const auth = await authenticateApiRequest(c.req.raw);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  requireScope(auth, "resources:write");

  let payload: z.infer<typeof pushBodySchema>;
  try {
    const raw = await c.req.json();
    payload = pushBodySchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request body", issues: err.issues }, 400);
    }
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const orgId = auth.organizationId;

  // Validate that every resource.accountId references either an account being
  // pushed in this request OR an account already owned by this organization.
  // This prevents a caller from attaching resources to accounts in other orgs.
  if (payload.resources && payload.resources.length > 0) {
    const pushedAccountIds = new Set((payload.accounts ?? []).map((a) => a.id));
    const referencedAccountIds = Array.from(
      new Set(
        payload.resources.flatMap((r) => (!pushedAccountIds.has(r.accountId) ? [r.accountId] : [])),
      ),
    );
    if (referencedAccountIds.length > 0) {
      const existing = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.organizationId, orgId), inArray(accounts.id, referencedAccountIds)));
      const existingIds = new Set(existing.map((r) => r.id));
      const missing = referencedAccountIds.filter((id) => !existingIds.has(id));
      if (missing.length > 0) {
        return c.json(
          {
            error: "Unknown accountId on resource(s)",
            accountIds: missing,
          },
          400,
        );
      }
    }
  }

  if (payload.accounts) {
    for (const acct of payload.accounts) {
      const { ciphertext, iv } = await encrypt(
        JSON.stringify(acct.credentials),
        buildAad("account", acct.id, "credentials"),
      );
      await db
        .insert(accounts)
        .values({
          id: acct.id,
          organizationId: orgId,
          pluginId: acct.pluginId,
          displayName: acct.displayName,
          encryptedCredentials: ciphertext,
          credentialsIv: iv,
          deletedAt: acct.deletedAt ? new Date(acct.deletedAt) : null,
          syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM accounts WHERE organization_id = ${orgId}), 0) + 1`,
          updatedAt: new Date(acct.updatedAt),
        })
        .onConflictDoUpdate({
          target: accounts.id,
          set: {
            displayName: acct.displayName,
            encryptedCredentials: ciphertext,
            credentialsIv: iv,
            deletedAt: acct.deletedAt ? new Date(acct.deletedAt) : null,
            syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM accounts WHERE organization_id = ${orgId}), 0) + 1`,
            updatedAt: new Date(acct.updatedAt),
          },
          where: eq(accounts.organizationId, orgId),
        });
    }
  }

  if (payload.resources) {
    for (const res of payload.resources) {
      await db
        .insert(resources)
        .values({
          id: res.id,
          organizationId: orgId,
          pluginId: res.pluginId,
          resourceTypeId: res.resourceTypeId,
          accountId: res.accountId,
          displayName: res.displayName,
          externalId: res.externalId ?? null,
          fieldsJson: res.fieldsJson ?? {},
          outputsJson: res.outputsJson ?? {},
          parentResourceId: res.parentResourceId ?? null,
          deletedAt: res.deletedAt ? new Date(res.deletedAt) : null,
          syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM resources WHERE organization_id = ${orgId}), 0) + 1`,
          updatedAt: new Date(res.updatedAt),
        })
        .onConflictDoUpdate({
          target: resources.id,
          set: {
            displayName: res.displayName,
            fieldsJson: res.fieldsJson ?? {},
            outputsJson: res.outputsJson ?? {},
            deletedAt: res.deletedAt ? new Date(res.deletedAt) : null,
            syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM resources WHERE organization_id = ${orgId}), 0) + 1`,
            updatedAt: new Date(res.updatedAt),
          },
          where: eq(resources.organizationId, orgId),
        });
    }
  }

  if (payload.dashboards) {
    for (const dash of payload.dashboards) {
      await db
        .insert(dashboards)
        .values({
          id: dash.id,
          organizationId: orgId,
          name: dash.name,
          isDefault: dash.isDefault,
          deletedAt: dash.deletedAt ? new Date(dash.deletedAt) : null,
          syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM dashboards WHERE organization_id = ${orgId}), 0) + 1`,
          updatedAt: new Date(dash.updatedAt),
        })
        .onConflictDoUpdate({
          target: dashboards.id,
          set: {
            name: dash.name,
            isDefault: dash.isDefault,
            deletedAt: dash.deletedAt ? new Date(dash.deletedAt) : null,
            syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM dashboards WHERE organization_id = ${orgId}), 0) + 1`,
            updatedAt: new Date(dash.updatedAt),
          },
          where: eq(dashboards.organizationId, orgId),
        });
    }
  }

  void logAudit({
    organizationId: orgId,
    userId: auth.userId,
    apiKeyId: auth.apiKeyId,
    action: "sync.push",
    entityType: "sync",
    entityId: orgId,
    metadata: {
      accounts: payload.accounts?.length ?? 0,
      resources: payload.resources?.length ?? 0,
      dashboards: payload.dashboards?.length ?? 0,
    },
  });

  return c.json({ ok: true });
});

/** GET /api/v1/sync/status */
app.get("/status", async (c) => {
  const auth = await authenticateApiRequest(c.req.raw);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  requireScope(auth, "resources:read");

  const orgId = auth.organizationId;

  const [maxVersions] = await db
    .select({
      accounts: sql<number>`COALESCE(MAX(${accounts.syncVersion}), 0)`,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, orgId));

  const [resourceVersions] = await db
    .select({
      resources: sql<number>`COALESCE(MAX(${resources.syncVersion}), 0)`,
    })
    .from(resources)
    .where(eq(resources.organizationId, orgId));

  const maxSyncVersion = Math.max(maxVersions?.accounts ?? 0, resourceVersions?.resources ?? 0);

  return c.json({ maxSyncVersion });
});

export { app as syncRoutes };
