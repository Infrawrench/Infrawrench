/**
 * Destroying an organization.
 *
 * Written for the trial reaper, but deliberately not trial-specific: this is
 * the only code in the repo that deletes an org, and there was none before it.
 * `POST /api/orgs` could always create one; nothing could ever remove one.
 *
 * The work spans three stores, and the order they are touched in is the whole
 * design. Postgres goes **last**, because the `organizations` row is the only
 * record that the other two have anything to clean up:
 *
 *  1. **ClickHouse** — metrics, cost, poll outcomes and network flows are
 *     org-scoped but carry no foreign key to anything. Nothing deletes them
 *     implicitly.
 *  2. **WorkOS** — the org exists there too, and an org we forget the id of is
 *     an org we can never delete.
 *  3. **Postgres** — one `DELETE`, and 76 tables cascade behind it.
 *
 * Any step failing aborts the rest and leaves the org intact for the next
 * sweep. That is the safe direction to fail in: an org that outlives its clock
 * by an hour is a billing curiosity, whereas half-deleted state spread across
 * three stores is unrecoverable without hand-written SQL. Every step is
 * idempotent, so the retry costs nothing.
 */
import { eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { agentAuthRegistrations, organizations, users } from "../db/schema.js";
import { getClickHouseClient, isClickHouseConfigured } from "../clickhouse/client.js";
import { agentUserId } from "./identity.js";

/**
 * Every ClickHouse table holding org-scoped rows.
 *
 * Hard-coded rather than derived from the schema module: a table added there
 * without a thought about deletion should show up as *data that outlives its
 * org*, and the only way to make that visible is to have one list that someone
 * has to remember to edit. `trials/__tests__/destroy.test.ts` asserts this list
 * covers every table in `clickhouse/schema.ts` that has an `organization_id`
 * column, so forgetting fails the build rather than leaking rows.
 */
export const ORG_SCOPED_CLICKHOUSE_TABLES = [
  "metric_points_raw",
  "metric_points_1m",
  "metric_points_1h",
  "dashboard_stats",
  "account_resource_counts",
  "poll_outcomes",
  "cost_daily",
  "network_flow_daily",
] as const;

export interface DestroyOrganizationResult {
  /** False when the org row was already gone — a concurrent sweep won the race. */
  deleted: boolean;
  /** Tables a purge was issued against. Empty when ClickHouse isn't configured. */
  clickhouseTablesPurged: readonly string[];
  /** Whether the WorkOS org was deleted (or was already absent). */
  workosDeleted: boolean;
  /**
   * Agent `users` rows removed with the org. Not covered by the cascade —
   * `users` is not org-scoped — so this is counted rather than assumed.
   */
  agentUsersDeleted: number;
}

/**
 * Issue the org-scoped purge across every ClickHouse table.
 *
 * `ALTER TABLE … DELETE` is a *mutation*: ClickHouse acknowledges the statement
 * and rewrites parts in the background, so a successful return means "accepted",
 * not "gone". `mutations_sync = 2` would make it synchronous, and is deliberately
 * not used — a reaper sweeping a batch of orgs would then block for as long as
 * the largest org's parts take to rewrite, turning a cheap tick into a stall.
 * The rows are unreachable either way: every read path filters by
 * `organization_id`, and that org is about to stop existing in Postgres.
 */
async function purgeClickHouse(organizationId: string): Promise<readonly string[]> {
  if (!isClickHouseConfigured()) return [];
  const client = getClickHouseClient();
  const purged: string[] = [];
  for (const table of ORG_SCOPED_CLICKHOUSE_TABLES) {
    // The table name is from the frozen list above, never from input; only the
    // org id is parameterised, and it must be, since org ids are user-visible.
    await client.command({
      query: `ALTER TABLE ${table} DELETE WHERE organization_id = {organizationId:String}`,
      query_params: { organizationId },
    });
    purged.push(table);
  }
  return purged;
}

/**
 * Re-parent an org's ClickHouse history onto another org.
 *
 * Used by a merge claim when the user asks to keep their trial's history. This
 * works — rather than orphaning rows against ids that no longer exist —
 * because `resources.id` is the provider's own id, assigned by the plugin and
 * globally unique (`sync-resources.ts` upserts on it). After the merge the
 * account re-polls into the target org and recreates the same resource ids, so
 * the moved series re-attach to the rows they described.
 *
 * Like the purge this is a background mutation, so the history reappears in the
 * target org shortly after the claim rather than instantly. That is worth
 * saying in the UI: a user who merges and immediately sees an empty cost graph
 * has been told the wrong thing by the absence.
 */
export async function moveOrgClickHouseData(
  fromOrganizationId: string,
  toOrganizationId: string,
): Promise<readonly string[]> {
  if (!isClickHouseConfigured()) return [];
  const client = getClickHouseClient();
  const moved: string[] = [];
  for (const table of ORG_SCOPED_CLICKHOUSE_TABLES) {
    await client.command({
      query:
        `ALTER TABLE ${table} UPDATE organization_id = {toOrganizationId:String} ` +
        `WHERE organization_id = {fromOrganizationId:String}`,
      query_params: { fromOrganizationId, toOrganizationId },
    });
    moved.push(table);
  }
  return moved;
}

/**
 * Delete the org from WorkOS.
 *
 * Uses `fetch` against the REST API rather than `@workos-inc/node` because
 * server-core does not depend on the SDK and should not start: the poller runs
 * this, and pulling an auth SDK into the polling service to issue one DELETE
 * would be a strange trade. Honours `WORKOS_API_HOSTNAME` so a deployment on a
 * custom Authentication API domain reaches the same place the rest of the app
 * does — once that domain is live, `api.workos.com` is unsupported.
 *
 * A 404 counts as success. The org being absent is the state we wanted.
 */
async function deleteWorkosOrganization(organizationId: string): Promise<boolean> {
  const apiKey = process.env["WORKOS_API_KEY"];
  if (!apiKey) {
    // Not fatal, but it does mean orgs accumulate in WorkOS. Say so loudly
    // rather than reporting a clean destroy that only cleaned two stores.
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
   * Skip the ClickHouse purge because the caller has already moved the rows
   * somewhere else (see {@link moveOrgClickHouseData}).
   *
   * This exists to avoid a race rather than to save work. `ALTER TABLE … UPDATE`
   * and `ALTER TABLE … DELETE` are both background mutations; ClickHouse applies
   * them per part in submission order, so a purge issued after a move *should*
   * find nothing — but "should, because of how the mutation queue is ordered" is
   * a thin thing to rest a customer's cost history on. Not issuing the delete at
   * all is the same outcome with nothing to reason about.
   */
  skipClickHouse?: boolean;
}

/**
 * Delete an organization and everything belonging to it, everywhere.
 *
 * Throws if any store refuses, having changed as little as possible — see the
 * module comment for why the ordering makes that safe.
 */
export async function destroyOrganization(
  organizationId: string,
  options: DestroyOrganizationOptions = {},
): Promise<DestroyOrganizationResult> {
  const clickhouseTablesPurged = options.skipClickHouse
    ? []
    : await purgeClickHouse(organizationId);
  const workosDeleted = await deleteWorkosOrganization(organizationId);

  // Read the org's registrations before the delete cascades them away. Their
  // agents' `users` rows are the one thing belonging to this org that does NOT
  // cascade — `users` is not org-scoped — so without this every expired trial
  // would leave an orphan user behind permanently.
  //
  // A registration re-pointed at another org by a merge is correctly absent
  // here, so that agent keeps the identity it still needs.
  const survivingAgents = await db
    .select({ id: agentAuthRegistrations.id })
    .from(agentAuthRegistrations)
    .where(eq(agentAuthRegistrations.organizationId, organizationId));

  const deleted = await db
    .delete(organizations)
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id });

  // After the org, so a failure above leaves the agent identity intact for the
  // retry rather than stranding a registration with no user to act as.
  let agentUsersDeleted = 0;
  if (deleted.length > 0 && survivingAgents.length > 0) {
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
    deleted: deleted.length > 0,
    clickhouseTablesPurged,
    workosDeleted,
    agentUsersDeleted,
  };
}
