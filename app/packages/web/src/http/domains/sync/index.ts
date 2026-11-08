/**
 * Desktop cloud sync: `/api/v1/sync`, the handlers.
 *
 * Every endpoint authenticates the bearer credential, then checks its scope
 * with `requireScope` (whose refusal is the plain-text 403 it has always
 * sent), then reads its input. The reads and writes are
 * promise code, called through `legacy`, and scoped to the credential's
 * organization; the payload shapes are what the desktop reads, byte for byte.
 */
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { stripOAuthGrantState } from "@infrawrench/plugin-base";
import { refreshAllowlistById } from "@infrawrench/server-core/bastion/registry";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import {
  badRequest,
  Ok,
  ok,
  SyncApi,
  SyncPullResponse,
  SyncPushRequest,
  SyncStatus,
} from "@infrawrench/api-contract";
import type { ApiAuthResult } from "../../../auth/api-auth";
import { MissingScopeError } from "../../../auth/scope-error";
import { effectivePermissions } from "../../../auth/effective-permissions";
import { db } from "../../../db/client";
import { accounts, associations, dashboardPins, dashboards, resources } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { buildAad, encrypt } from "../../../services/encryption";
import {
  filterVisibleObjects,
  resolveSharingPrincipal,
  runWithSharingPrincipal,
} from "../../../services/object-sharing";
import { asBearerCaller } from "../../bearer-caller";
import { makeDomain } from "../../domain";
import { decodeAsPayload, fieldsOf, readJsonOr } from "../../request-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { json } from "../../middleware";
import { respond } from "../../response";

/**
 * `requireScope(auth, scope)`, answering its refusal as this surface always
 * has: the bare sentence as a plain-text 403 (what Hono's
 * `HTTPException.getResponse()` sent while the API ran on Hono), not the
 * `{ error }` JSON the rest of the API answers with.
 */
const scopeRefusal = (auth: ApiAuthResult, scope: string) =>
  legacyTry(
    // Imported on use: `auth/api-auth.ts` loads the WorkOS client (see `http/bearer-caller.ts`).
    async () => (await import("../../../auth/api-auth")).requireScope(auth, scope),
    (error) => (error instanceof MissingScopeError ? error : undefined),
  ).pipe(
    Effect.as(undefined),
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.text(error.message, {
          status: error.status,
          contentType: "text/plain;charset=UTF-8",
        }),
      ),
    ),
  );

const isSyncVersion = Schema.is(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

/** Every table `/pull` returns, rows changed after `lastSyncVersion`, in `orgId`. */
async function pullChanges(auth: ApiAuthResult, lastSyncVersion: number) {
  const orgId = auth.organizationId;
  const [accountRows, resourceRows, dashboardRows, pinRows, assocRows] = await Promise.all([
    db
      .select({
        id: accounts.id,
        pluginId: accounts.pluginId,
        displayName: accounts.displayName,
        // Deliberately NOT the ciphertext. It is sealed with the server's
        // master key, so no client can read it: shipping it put
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
    // own: they are scoped transitively through the row they hang off. Both
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

  // Dashboard sharing applies here too: a dashboard (and its pins) the caller
  // cannot open is not theirs to pull.
  const sharing = await resolveSharingPrincipal(
    orgId,
    auth.userId,
    await effectivePermissions({
      userId: auth.userId,
      organizationId: orgId,
      scopes: auth.scopes ?? [],
      agentRegistrationId: auth.agentRegistrationId,
    }),
  );
  const visibleDashboards = await runWithSharingPrincipal(sharing, () =>
    filterVisibleObjects(orgId, "dashboard", dashboardRows, (d) => d.id),
  );
  const visibleIds = new Set(visibleDashboards.map((d) => d.id));

  return {
    accounts: accountRows,
    resources: resourceRows,
    dashboards: visibleDashboards,
    dashboardPins: pinRows.filter((pin) => visibleIds.has(pin.dashboardId)),
    associations: assocRows,
  };
}

/**
 * The account ids `resources` reference that are neither pushed alongside
 * them nor already this organization's. Stops a caller attaching resources
 * to accounts in other orgs.
 */
async function unknownAccountIds(
  orgId: string,
  payload: typeof SyncPushRequest.Type,
): Promise<string[]> {
  if (!payload.resources || payload.resources.length === 0) return [];
  const pushedAccountIds = new Set((payload.accounts ?? []).map((a) => a.id));
  const referencedAccountIds = Array.from(
    new Set(
      payload.resources.flatMap((r) => (!pushedAccountIds.has(r.accountId) ? [r.accountId] : [])),
    ),
  );
  if (referencedAccountIds.length === 0) return [];
  const existing = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, orgId), inArray(accounts.id, referencedAccountIds)));
  const existingIds = new Set(existing.map((r) => r.id));
  return referencedAccountIds.filter((id) => !existingIds.has(id));
}

/** Upsert every pushed row, last write wins, each table's sync version bumped. */
async function writePush(orgId: string, payload: typeof SyncPushRequest.Type): Promise<void> {
  for (const acct of payload.accounts ?? []) {
    // A pushed account is a pasted credential set as far as the cloud is
    // concerned: provider OAuth grant state is never accepted through sync
    // (a desktop-issued refresh token must not be refreshed from two places).
    const { ciphertext, iv } = await encrypt(
      JSON.stringify(stripOAuthGrantState(acct.credentials)),
      buildAad("account", acct.id, "credentials"),
    );
    const [written] = await db
      .insert(accounts)
      .values({
        id: acct.id,
        organizationId: orgId,
        pluginId: acct.pluginId,
        displayName: acct.displayName,
        encryptedCredentials: ciphertext,
        credentialsIv: iv,
        oauthStatus: null,
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
          oauthStatus: null,
          deletedAt: acct.deletedAt ? new Date(acct.deletedAt) : null,
          syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM accounts WHERE organization_id = ${orgId}), 0) + 1`,
          updatedAt: new Date(acct.updatedAt),
        },
        where: eq(accounts.organizationId, orgId),
      })
      .returning({ bastionId: accounts.bastionId });
    // A pushed credential set may have moved the host this account configured.
    if (written?.bastionId) {
      const { bastionId } = written;
      void keepAlive(
        refreshAllowlistById(bastionId).catch((err: unknown) => {
          console.error(`[sync] refreshAllowlistById(${bastionId}) failed:`, err);
        }),
      );
    }
  }

  for (const res of payload.resources ?? []) {
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

  for (const dash of payload.dashboards ?? []) {
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

/**
 * The highest sync version across every table `/pull` returns. Must cover all
 * of them: a client that advances its watermark to this number would
 * otherwise step straight over changes in any table missing here and never
 * see them again, since the counter only moves forward. Pins and
 * associations join their parent for the org filter, having no
 * `organization_id` of their own.
 */
async function maxSyncVersion(orgId: string): Promise<number> {
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
  return maxVersions?.max ?? 0;
}

/** What `c.req.json()` failing to parse read as: distinct from any JSON value. */
const NOT_JSON = Symbol("not json");

const SyncHandlers = HttpApiBuilder.group(SyncApi, "sync", (handlers) =>
  handlers
    .handleRaw("pull", ({ request }) =>
      asBearerCaller((auth) =>
        Effect.gen(function* () {
          const refused = yield* scopeRefusal(auth, "resources:read");
          if (refused) return refused;

          // Validated, not just typed. Every row starts at sync_version 0, so an
          // unchecked negative here turns `syncVersion > lastSyncVersion` into
          // "match everything", which is how a caller reached rows the query
          // didn't intend to return. The org scoping is the real fix; this
          // keeps a bad value from widening any future query that forgets one.
          const body = yield* fieldsOf(yield* readJsonOr(request, {}));
          const lastSyncVersion = body["lastSyncVersion"];
          if (!isSyncVersion(lastSyncVersion)) {
            return yield* badRequest("lastSyncVersion must be a non-negative integer");
          }

          const pulled = yield* legacy(() => pullChanges(auth, lastSyncVersion));
          return yield* respond(SyncPullResponse)(pulled);
        }),
      ),
    )
    .handleRaw("push", ({ request }) =>
      asBearerCaller((auth) =>
        Effect.gen(function* () {
          const refused = yield* scopeRefusal(auth, "resources:write");
          if (refused) return refused;

          const raw = yield* readJsonOr(request, NOT_JSON);
          if (raw === NOT_JSON) return yield* badRequest("Invalid JSON body");
          const payload = yield* decodeAsPayload(SyncPushRequest, raw);
          const orgId = auth.organizationId;

          const missing = yield* legacy(() => unknownAccountIds(orgId, payload));
          if (missing.length > 0) {
            return json({ error: "Unknown accountId on resource(s)", accountIds: missing }, 400);
          }

          yield* legacy(() => writePush(orgId, payload));

          yield* fireAndForget(() =>
            logAudit({
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
            }),
          );

          return yield* respond(Ok)(ok);
        }),
      ),
    )
    .handleRaw("status", () =>
      asBearerCaller((auth) =>
        Effect.gen(function* () {
          const refused = yield* scopeRefusal(auth, "resources:read");
          if (refused) return refused;
          const max = yield* legacy(() => maxSyncVersion(auth.organizationId));
          return yield* respond(SyncStatus)({ maxSyncVersion: max });
        }),
      ),
    ),
);

export const syncDomain = makeDomain("sync", SyncApi, SyncHandlers);
