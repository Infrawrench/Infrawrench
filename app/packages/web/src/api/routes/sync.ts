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

  // Validated, not just typed. Every row starts at sync_version 0, so an
  // unchecked negative here turns `syncVersion > lastSyncVersion` into "match
  // everything" — which is how a caller reached rows the query didn't intend
  // to return. The org scoping below is the real fix; this keeps a bad value
  // from widening any future query that forgets one.
  const body = await c.req
    .json<{ lastSyncVersion?: unknown }>()
    .catch(() => ({}) as { lastSyncVersion?: unknown });
  const parsed = z.number().int().min(0).safeParse(body.lastSyncVersion);
  if (!parsed.success) {
    return c.json({ error: "lastSyncVersion must be a non-negative integer" }, 400);
  }
  const lastSyncVersion = parsed.data;
  const orgId = auth.organizationId;

  const [accountRows, resourceRows, dashboardRows, pinRows, assocRows] = await Promise.all([
    db
      .select({
        id: accounts.id,
        pluginId: accounts.pluginId,
        displayName: accounts.displayName,
        // Deliberately NOT the ciphertext. It is sealed with the server's
        // master key, so no client can read it — shipping it put
        // credential-shaped material on the wire and in client logs for
        // exactly zero benefit. Callers that genuinely need a credential use
        // `GET /accounts/:id/credentials`, which is gated on `secrets:read`
        // (this route only requires `resources:read`) and audit-logged.
        hasCredentials: sql<boolean>`${accounts.encryptedCredentials} IS NOT NULL AND ${accounts.encryptedCredentials} <> ''`,
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
    // `dashboard_pins` and `associations` carry no organization_id of their
    // own — they are scoped transitively through the row they hang off. Both
    // MUST join to that parent and filter on it, or the pull returns every
    // organization's rows to any caller.
    db
      .select({
        id: dashboardPins.id,
        dashboardId: dashboardPins.dashboardId,
        resourceId: dashboardPins.resourceId,
        gridX: dashboardPins.gridX,
        gridY: dashboardPins.gridY,
        gridW: dashboardPins.gridW,
        gridH: dashboardPins.gridH,
        syncVersion: dashboardPins.syncVersion,
        deletedAt: dashboardPins.deletedAt,
        createdAt: dashboardPins.createdAt,
      })
      .from(dashboardPins)
      .innerJoin(dashboards, eq(dashboards.id, dashboardPins.dashboardId))
      .where(
        and(eq(dashboards.organizationId, orgId), gt(dashboardPins.syncVersion, lastSyncVersion)),
      ),
    db
      .select({
        id: associations.id,
        consumerResourceId: associations.consumerResourceId,
        consumerFieldKey: associations.consumerFieldKey,
        providerResourceId: associations.providerResourceId,
        providerOutputKey: associations.providerOutputKey,
        syncVersion: associations.syncVersion,
        deletedAt: associations.deletedAt,
        createdAt: associations.createdAt,
        updatedAt: associations.updatedAt,
      })
      .from(associations)
      .innerJoin(resources, eq(resources.id, associations.consumerResourceId))
      .where(
        and(eq(resources.organizationId, orgId), gt(associations.syncVersion, lastSyncVersion)),
      ),
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

  // Must cover every table `/pull` returns. A client that advances its
  // watermark to this number would otherwise step straight over changes in any
  // table missing here and never see them again — the counter only moves
  // forward. Pins and associations join their parent for the org filter,
  // having no `organization_id` of their own.
  const [maxVersions] = await db
    .select({
      max: sql<number>`GREATEST(
        COALESCE((SELECT MAX(sync_version) FROM accounts WHERE organization_id = ${orgId}), 0),
        COALESCE((SELECT MAX(sync_version) FROM resources WHERE organization_id = ${orgId}), 0),
        COALESCE((SELECT MAX(sync_version) FROM dashboards WHERE organization_id = ${orgId}), 0),
        COALESCE((
          SELECT MAX(p.sync_version) FROM dashboard_pins p
          JOIN dashboards d ON d.id = p.dashboard_id
          WHERE d.organization_id = ${orgId}
        ), 0),
        COALESCE((
          SELECT MAX(a.sync_version) FROM associations a
          JOIN resources r ON r.id = a.consumer_resource_id
          WHERE r.organization_id = ${orgId}
        ), 0)
      )`,
    })
    .from(sql`(SELECT 1) AS _`);

  return c.json({ maxSyncVersion: maxVersions?.max ?? 0 });
});

export { app as syncRoutes };
