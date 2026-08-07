import { sql } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import type { PollAccountRow } from "./poll-account";

/**
 * Atomic work-claiming so any number of poller instances can run against the
 * same database without double-polling. Each claim is a single
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` statement:
 * concurrent instances skip past each other's locked rows instead of blocking,
 * and a row is only ever returned to one claimer.
 *
 * The claim writes a lease into the row's own due-time column (`next_poll_at` /
 * `next_run_at`), so no extra schema is needed. The normal completion path
 * overwrites the lease with the real next schedule; if an instance dies
 * mid-work, the row simply becomes due again when the lease expires.
 */

/**
 * Must exceed the worst-case duration of a full account sync, or a second
 * instance would start the same poll while the first is still running.
 */
export const ACCOUNT_LEASE_MS = 5 * 60 * 1000;

/**
 * Fallback only: the claimer immediately replaces this with the cron's true
 * next fire time. It bounds the retry delay if that reschedule write fails.
 */
export const WORKFLOW_LEASE_MS = 10 * 60 * 1000;

/**
 * Cost collection leases are long because the first run backfills up to a
 * year of history in month chunks against slow, rate-limited billing APIs.
 */
export const COST_LEASE_MS = 30 * 60 * 1000;

export interface DueWorkflowRow {
  id: string;
  organizationId: string;
  trigger: unknown;
}

/**
 * Claim up to `limit` due accounts, leasing each for {@link ACCOUNT_LEASE_MS}.
 * Ordering matches the old single-instance query: least-recently-polled first,
 * with never-polled accounts (fresh sign-ups) at the front.
 */
export async function claimDueAccounts(limit: number): Promise<PollAccountRow[]> {
  const rows = await db.execute(sql`
    UPDATE accounts
    SET next_poll_at = now() + ${ACCOUNT_LEASE_MS}::float8 * interval '1 millisecond'
    WHERE id IN (
      SELECT id FROM accounts
      WHERE deleted_at IS NULL
        AND (next_poll_at IS NULL OR next_poll_at <= now())
      ORDER BY last_polled_at ASC NULLS FIRST, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, organization_id, plugin_id, display_name, poll_failure_count
  `);

  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    organizationId: String(r["organization_id"]),
    pluginId: String(r["plugin_id"]),
    displayName: String(r["display_name"]),
    pollFailureCount: Number(r["poll_failure_count"]),
  }));
}

/**
 * Claim up to `limit` accounts due for cost collection, leasing each for
 * {@link COST_LEASE_MS}. `costCapablePluginIds` is the static list of plugins
 * whose manifest declares a `costs` capability (known at boot); accounts of
 * other plugins are never claimed. NULL cost_next_poll_at means "due now" so
 * pre-existing accounts are picked up automatically after deploy.
 */
export async function claimDueCostAccounts(
  limit: number,
  costCapablePluginIds: string[],
): Promise<PollAccountRow[]> {
  if (costCapablePluginIds.length === 0) return [];
  const rows = await db.execute(sql`
    UPDATE accounts
    SET cost_next_poll_at = now() + ${COST_LEASE_MS}::float8 * interval '1 millisecond'
    WHERE id IN (
      SELECT id FROM accounts
      WHERE deleted_at IS NULL
        -- IN, not = ANY(): the sql tag expands a JS array into a parenthesized
        -- placeholder list ($2, $3, …), which is what IN takes. ANY() wants a
        -- real array on the right and fails with 42809 against that list.
        AND plugin_id IN ${costCapablePluginIds}
        AND (cost_next_poll_at IS NULL OR cost_next_poll_at <= now())
      ORDER BY cost_last_polled_at ASC NULLS FIRST, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, organization_id, plugin_id, display_name, cost_poll_failure_count
  `);

  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    organizationId: String(r["organization_id"]),
    pluginId: String(r["plugin_id"]),
    displayName: String(r["display_name"]),
    pollFailureCount: Number(r["cost_poll_failure_count"]),
  }));
}

/**
 * Claim up to `limit` accounts due a credit-balance read.
 *
 * Same SKIP LOCKED lease protocol as the cost claim, but keyed off
 * `account_credit_polls` rather than columns on `accounts`. Credit-capable
 * plugins are a small minority, so a row that exists only for accounts the
 * pass has touched keeps this a scan of a tiny table — and the LEFT JOIN is
 * what lets an account with no row yet still come due immediately.
 */
export async function claimDueCreditAccounts(
  limit: number,
  creditCapablePluginIds: string[],
): Promise<PollAccountRow[]> {
  if (creditCapablePluginIds.length === 0) return [];
  const rows = await db.execute(sql`
    INSERT INTO account_credit_polls (account_id, organization_id, next_poll_at)
    SELECT a.id, a.organization_id,
           now() + ${COST_LEASE_MS}::float8 * interval '1 millisecond'
    FROM accounts a
    LEFT JOIN account_credit_polls p ON p.account_id = a.id
    WHERE a.deleted_at IS NULL
      -- IN, not = ANY(): see the note on claimDueCostAccounts.
      AND a.plugin_id IN ${creditCapablePluginIds}
      AND (p.account_id IS NULL OR p.next_poll_at IS NULL OR p.next_poll_at <= now())
    ORDER BY p.last_polled_at ASC NULLS FIRST, a.id ASC
    LIMIT ${limit}
    ON CONFLICT (account_id) DO UPDATE
      SET next_poll_at = now() + ${COST_LEASE_MS}::float8 * interval '1 millisecond'
    RETURNING account_id, organization_id, failure_count
  `);

  const claimed = Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["account_id"]),
    organizationId: String(r["organization_id"]),
    failureCount: Number(r["failure_count"]),
  }));
  if (claimed.length === 0) return [];

  // The claim writes to `account_credit_polls`, which carries no plugin id or
  // display name; both come back in one follow-up read rather than being
  // denormalized onto the poll row, where they would go stale on a rename.
  const details = await db.execute(sql`
    SELECT id, plugin_id, display_name FROM accounts
    WHERE id IN ${claimed.map((c) => c.id)}
  `);
  const byId = new Map(
    Array.from(details as Iterable<Record<string, unknown>>, (r) => [
      String(r["id"]),
      { pluginId: String(r["plugin_id"]), displayName: String(r["display_name"]) },
    ]),
  );

  return claimed.flatMap((c) => {
    const detail = byId.get(c.id);
    if (!detail) return [];
    return [
      {
        id: c.id,
        organizationId: c.organizationId,
        pluginId: detail.pluginId,
        displayName: detail.displayName,
        pollFailureCount: c.failureCount,
      },
    ];
  });
}

/** Claim up to `limit` due cron workflows, leasing each for {@link WORKFLOW_LEASE_MS}. */
export async function claimDueWorkflows(limit: number): Promise<DueWorkflowRow[]> {
  const rows = await db.execute(sql`
    UPDATE workflows
    SET next_run_at = now() + ${WORKFLOW_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT id FROM workflows
      WHERE enabled = true
        AND deleted_at IS NULL
        AND next_run_at IS NOT NULL
        AND next_run_at <= now()
      ORDER BY next_run_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, organization_id, trigger
  `);

  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    organizationId: String(r["organization_id"]),
    trigger: r["trigger"],
  }));
}
