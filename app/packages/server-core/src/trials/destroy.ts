/**
 * Destroying an organization.
 *
 * Written for the trial reaper, but deliberately not trial-specific: this is
 * the only code in the repo that deletes an org, and there was none before it.
 * `POST /api/orgs` could always create one; nothing could ever remove one.
 *
 * The work spans two stores, and the order they are touched in is the whole
 * design:
 *
 *  1. **WorkOS**: first, because it is the only fallible step that changes
 *     nothing on our side. Most orgs (every trial org: their ids are local
 *     UUIDs, minted by us) have no WorkOS counterpart at all, and the 404
 *     answers count as success; but when WorkOS *refuses* (rotated key, an
 *     outage), aborting here leaves the org genuinely intact everywhere.
 *  2. **Postgres**: one transaction. Deleting the `organizations` row
 *     cascades 76 tables behind it; the analytics tables (metrics, cost, poll
 *     outcomes, network flows, AI attribution) carry no foreign key, so they
 *     are deleted explicitly in the same transaction, and only once the org
 *     row's delete has actually matched. Either all of it happens or none.
 *
 * Any step failing aborts the rest and leaves the org intact for the next
 * sweep. That is the safe direction to fail in: an org that outlives its clock
 * by an hour is a billing curiosity, whereas half-deleted state is
 * unrecoverable without hand-written SQL. Every step is idempotent, so the
 * retry costs nothing.
 *
 * The reaper additionally passes {@link DestroyOrganizationOptions.expiredTrialOnly},
 * which takes the per-org lock in `lock.ts` and re-checks the org is *still*
 * an expired, unclaimed trial before anything irreversible happens: a claim
 * ceremony completing in the window between the reaper's due-query and this
 * function must win, not be silently deleted underneath.
 */
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { db } from "../db/client.js";
import {
  accountResourceCounts,
  agentAuthRegistrations,
  aiCostAttributed,
  aiRequestDaily,
  costDaily,
  dashboardStats,
  metricPoints1h,
  metricPoints1m,
  metricPointsRaw,
  networkFlowDaily,
  organizations,
  pollOutcomes,
  users,
} from "../db/schema.js";
import { agentUserId } from "./identity.js";
import { withTrialOrgLock } from "./lock.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Every analytics table holding org-scoped rows.
 *
 * Hard-coded rather than derived from the schema module: a table added there
 * without a thought about deletion should show up as *data that outlives its
 * org*, and the only way to make that visible is to have one list that someone
 * has to remember to edit. `trials/__tests__/destroy-coverage.test.ts` asserts
 * this list covers every table in `db/analytics-schema.ts` that has an
 * `organization_id` column, so forgetting fails the build rather than leaking
 * rows. Everything else org-scoped hangs off `organizations` by foreign key and
 * goes with it.
 */
export const ORG_SCOPED_ANALYTICS_TABLES = [
  metricPointsRaw,
  metricPoints1m,
  metricPoints1h,
  dashboardStats,
  accountResourceCounts,
  pollOutcomes,
  costDaily,
  networkFlowDaily,
  aiRequestDaily,
  aiCostAttributed,
] as const;

export interface DestroyOrganizationResult {
  /**
   * False when nothing was destroyed: the org row was already gone (a
   * concurrent sweep won the race), or (on the guarded reaper path) the org
   * stopped being an expired unclaimed trial before anything was touched,
   * which is what a claim landing in the window looks like.
   */
  deleted: boolean;
  /** Analytics tables the org's rows were deleted from. Empty when nothing was deleted. */
  analyticsTablesPurged: readonly string[];
  /** Whether the WorkOS org was deleted (or was already absent). */
  workosDeleted: boolean;
  /**
   * Agent `users` rows removed with the org. Not covered by the cascade
   * (`users` is not org-scoped) so this is counted rather than assumed.
   */
  agentUsersDeleted: number;
}

/** Delete the org's rows from every analytics table, inside the caller's transaction. */
async function purgeAnalytics(tx: Tx, organizationId: string): Promise<readonly string[]> {
  const purged: string[] = [];
  for (const table of ORG_SCOPED_ANALYTICS_TABLES) {
    await tx.delete(table).where(eq(table.organization_id, organizationId));
    purged.push(getTableConfig(table).name);
  }
  return purged;
}

/**
 * Re-parent an org's analytics history onto another org.
 *
 * Used by a merge claim when the user asks to keep their trial's history. This
 * works (rather than orphaning rows against ids that no longer exist)
 * because `resources.id` is the provider's own id, assigned by the plugin and
 * globally unique (`sync-resources.ts` upserts on it). After the merge the
 * account re-polls into the target org and recreates the same resource ids, so
 * the moved series re-attach to the rows they described.
 *
 * The same property means the target can already hold a row the trial has
 * too: an account connected to both orgs was polled by both, so the trial's
 * metric points for a resource can share their whole key with the target's.
 * Re-parenting those would violate the primary key, so a trial row whose key
 * the target already has is dropped first and the target's kept: it is the
 * same reading, polled twice. One transaction, so the history moves whole or
 * not at all.
 */
export async function moveOrgAnalyticsData(
  fromOrganizationId: string,
  toOrganizationId: string,
): Promise<readonly string[]> {
  return await db.transaction(async (tx) => {
    const moved: string[] = [];
    for (const table of ORG_SCOPED_ANALYTICS_TABLES) {
      const config = getTableConfig(table);
      const keyColumns = (config.primaryKeys[0]?.columns ?? []).filter(
        (column) => column.name !== "organization_id",
      );
      if (keyColumns.length > 0) {
        const sameKey = sql.join(
          keyColumns.map(
            (column) =>
              sql`moving.${sql.identifier(column.name)} = kept.${sql.identifier(column.name)}`,
          ),
          sql` AND `,
        );
        await tx.execute(
          sql`DELETE FROM ${table} AS moving USING ${table} AS kept WHERE moving.organization_id = ${fromOrganizationId} AND kept.organization_id = ${toOrganizationId} AND ${sameKey}`,
        );
      }
      await tx
        .update(table)
        .set({ organization_id: toOrganizationId })
        .where(eq(table.organization_id, fromOrganizationId));
      moved.push(config.name);
    }
    return moved;
  });
}

/**
 * Delete the org from WorkOS.
 *
 * Uses `fetch` against the REST API rather than `@workos-inc/node` because
 * server-core does not depend on the SDK and should not start: the poller runs
 * this, and pulling an auth SDK into the polling service to issue one DELETE
 * would be a strange trade. Honours `WORKOS_API_HOSTNAME` so a deployment on a
 * custom Authentication API domain reaches the same place the rest of the app
 * does: once that domain is live, `api.workos.com` is unsupported.
 *
 * A 404 counts as success, and is the *expected* answer for every trial org:
 * trial org ids are local UUIDs and nothing in the repo creates a WorkOS
 * organization for them. The call is kept (cheap, and it covers any org that
 * does have a WorkOS counterpart) but it must never be treated as evidence
 * the org "exists there too".
 */
async function deleteWorkosOrganization(organizationId: string): Promise<boolean> {
  const apiKey = process.env["WORKOS_API_KEY"];
  if (!apiKey) {
    // Not fatal, but it does mean any WorkOS-side orgs accumulate. Say so
    // loudly rather than reporting a clean destroy that only cleaned two stores.
    console.warn(
      `[trials] WORKOS_API_KEY is unset; leaving WorkOS organization ${organizationId} in place`,
    );
    return false;
  }
  const host = process.env["WORKOS_API_HOSTNAME"] ?? "api.workos.com";
  const scheme = process.env["WORKOS_API_HTTPS"] === "false" ? "http" : "https";
  const port = process.env["WORKOS_API_PORT"];
  const origin = `${scheme}://${host}${port ? `:${port}` : ""}`;

  const res = await fetch(`${origin}/organizations/${encodeURIComponent(organizationId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
    // Bounded: on the guarded reaper path this runs while holding the per-org
    // lock, and an unbounded hang there would block a claim of the same org.
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return true;
  if (!res.ok) {
    throw new Error(
      `WorkOS organization delete failed for ${organizationId}: ${res.status} ${await res.text()}`,
    );
  }
  return true;
}

export interface DestroyOrganizationOptions {
  /**
   * Reaper path: take the per-org lock and destroy only if the org is *still*
   * an expired, unclaimed trial at `now`. A claim that completed after the
   * reaper's due-query cleared `trialExpiresAt` (adopt) or is holding the lock
   * mid-merge wins, and the result reports `deleted: false`.
   *
   * Never set this from a code path that already holds the org's lock: see
   * `lock.ts` for the re-entrancy rule.
   */
  expiredTrialOnly?: { now: Date };
}

/**
 * Delete an organization and everything belonging to it, everywhere.
 *
 * Throws if any store refuses, having changed as little as possible: see the
 * module comment for why the ordering makes that safe.
 */
export async function destroyOrganization(
  organizationId: string,
  options: DestroyOrganizationOptions = {},
): Promise<DestroyOrganizationResult> {
  if (options.expiredTrialOnly) {
    const { now } = options.expiredTrialOnly;
    return await withTrialOrgLock(organizationId, async () => {
      // Re-checked under the lock: the due-query's answer is stale the moment
      // it returns, and this is the last point a claim can still win.
      const [org] = await db
        .select({
          trialExpiresAt: organizations.trialExpiresAt,
          claimedAt: organizations.claimedAt,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      const stillExpiredTrial =
        org !== undefined &&
        org.trialExpiresAt !== null &&
        org.trialExpiresAt <= now &&
        org.claimedAt === null;
      if (!stillExpiredTrial) {
        return {
          deleted: false,
          analyticsTablesPurged: [],
          workosDeleted: false,
          agentUsersDeleted: 0,
        };
      }
      return await destroyStores(organizationId, { trialGuardNow: now });
    });
  }
  return await destroyStores(organizationId, {});
}

async function destroyStores(
  organizationId: string,
  guard: { trialGuardNow?: Date },
): Promise<DestroyOrganizationResult> {
  const workosDeleted = await deleteWorkosOrganization(organizationId);

  // Read the org's registrations before the delete cascades them away. Their
  // agents' `users` rows are the one thing belonging to this org that does NOT
  // cascade (`users` is not org-scoped) so without this every expired trial
  // would leave an orphan user behind permanently.
  //
  // A registration re-pointed at another org by a merge is correctly absent
  // here, so that agent keeps the identity it still needs.
  const survivingAgents = await db
    .select({ id: agentAuthRegistrations.id })
    .from(agentAuthRegistrations)
    .where(eq(agentAuthRegistrations.organizationId, organizationId));

  const { deleted, analyticsTablesPurged } = await db.transaction(async (tx) => {
    // On the reaper path the guard predicates ride on the DELETE itself as
    // well: the lock already serialises claims, so this is belt and braces, but
    // the row this braces against being deleted is a paying customer's org.
    const removed = await tx
      .delete(organizations)
      .where(
        guard.trialGuardNow
          ? and(
              eq(organizations.id, organizationId),
              lte(organizations.trialExpiresAt, guard.trialGuardNow),
              isNull(organizations.claimedAt),
            )
          : eq(organizations.id, organizationId),
      )
      .returning({ id: organizations.id });
    // The analytics rows go only with the org row: a guard that declined the
    // delete must leave the org's history exactly as it was.
    if (removed.length === 0) return { deleted: false, analyticsTablesPurged: [] };
    return { deleted: true, analyticsTablesPurged: await purgeAnalytics(tx, organizationId) };
  });

  // After the org, so a failure above leaves the agent identity intact for the
  // retry rather than stranding a registration with no user to act as.
  let agentUsersDeleted = 0;
  if (deleted && survivingAgents.length > 0) {
    const removed = await db
      .delete(users)
      .where(
        inArray(
          users.id,
          survivingAgents.map((r) => agentUserId(r.id)),
        ),
      )
      .returning({ id: users.id });
    agentUsersDeleted = removed.length;
  }

  return {
    deleted,
    analyticsTablesPurged,
    workosDeleted,
    agentUsersDeleted,
  };
}
