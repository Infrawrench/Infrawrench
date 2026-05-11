import { Hono } from "hono";
import { eq, gt, and, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, resources, dashboards, dashboardPins, associations } from "../../db/schema";
import { authenticateApiRequest, requireScope } from "../../auth/api-auth";
import { encrypt } from "../../services/encryption";
import { logAudit } from "../../services/audit";

const app = new Hono();

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

  const payload = await c.req.json<{
    accounts?: Array<{
      id: string;
      pluginId: string;
      displayName: string;
      credentials: Record<string, string>;
      updatedAt: string;
      deletedAt?: string | null;
    }>;
    resources?: Array<{
      id: string;
      pluginId: string;
      resourceTypeId: string;
      accountId: string;
      displayName: string;
      externalId?: string | null;
      fieldsJson: unknown;
      outputsJson: unknown;
      parentResourceId?: string | null;
      updatedAt: string;
      deletedAt?: string | null;
    }>;
    dashboards?: Array<{
      id: string;
      name: string;
      isDefault: boolean;
      updatedAt: string;
      deletedAt?: string | null;
    }>;
  }>();
  const orgId = auth.organizationId;

  if (payload.accounts) {
    for (const acct of payload.accounts) {
      const { ciphertext, iv } = await encrypt(JSON.stringify(acct.credentials));
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
