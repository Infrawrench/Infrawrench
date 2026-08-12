/**
 * The background half of "no member runs without an expiry".
 *
 * Every recovery layer in `instantiate.ts` used to hang off `GET /instances`,
 * which made the safety net conditional on somebody opening the page — and the
 * environment whose creation failed badly is precisely the one nobody opens
 * again, and the one still billing. A guarantee that depends on a human's
 * curiosity is not a guarantee.
 *
 * So the poller runs it, on the same footing as the lease pass it feeds. The
 * read path still calls the same functions (a fast path, and it makes the page
 * self-healing) but it is no longer the only trigger.
 *
 * Concurrency: repair **claims** its rows with the `resource_leases`
 * `next_check_at` protocol — `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
 * LOCKED) RETURNING` — because it is not idempotent work: it creates leases
 * and can delete a resource. Reconciliation deliberately does not claim: every
 * write it makes is idempotent (mark a member `deleted`, close an instance),
 * so two replicas doing it at once reach the same state, and a claim column
 * would be ceremony rather than safety.
 */
import { sql } from "drizzle-orm";
import { repairBackoffMs } from "@infrawrench/client-core";
import { db } from "../db/client";
import { reconcileEnvironmentInstances, repairClaimedMember } from "./instantiate";

/** How long a claim holds a member before another replica may retry it. */
const REPAIR_LEASE_MS = 10 * 60_000;

export interface EnvironmentRepairPassOptions {
  /** Members to repair per tick. */
  limit?: number;
  /**
   * Narrow to one organization. The read path passes this so opening the page
   * repairs that org's members promptly without touching anyone else's — and,
   * because it goes through the same claim, without racing the poller.
   */
  organizationId?: string | undefined;
}

export interface EnvironmentRepairPassResult {
  claimed: number;
  repaired: number;
  failed: number;
}

export interface ClaimedRepairMember {
  id: string;
  instanceId: string;
  organizationId: string;
  memberKey: string;
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  status: string;
  leaseId: string | null;
  repairAttempts: number;
  expiresAt: Date;
  instanceName: string;
}

/**
 * Claim members holding a resource with no lease on it.
 *
 * The predicate is the one `memberNeedsLeaseRepair` states — a resource id
 * with no lease — and deliberately carries **no instance-status filter**, for
 * the reason recorded in `instantiate.ts`: instance status summarises how a
 * run went and only correlates with what it still holds.
 */
async function claimDueRepairs(
  limit: number,
  organizationId?: string | undefined,
): Promise<ClaimedRepairMember[]> {
  const orgFilter = organizationId ? sql`AND m.organization_id = ${organizationId}` : sql``;
  const rows = await db.execute(sql`
    UPDATE environment_instance_members
    SET next_repair_at = now() + ${REPAIR_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT m.id FROM environment_instance_members m
      JOIN environment_instances i ON i.id = m.instance_id
      WHERE m.resource_id IS NOT NULL
        AND m.lease_id IS NULL
        AND m.status IN ('created', 'failed')
        AND i.status <> 'deleted'
        AND (m.next_repair_at IS NULL OR m.next_repair_at <= now())
        ${orgFilter}
      ORDER BY m.next_repair_at ASC NULLS FIRST, m.id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      id,
      instance_id,
      organization_id,
      member_key,
      resource_id,
      account_id,
      plugin_id,
      resource_type_id,
      status,
      lease_id,
      repair_attempts,
      (SELECT expires_at FROM environment_instances WHERE id = instance_id) AS expires_at,
      (SELECT name FROM environment_instances WHERE id = instance_id) AS instance_name
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    instanceId: String(r["instance_id"]),
    organizationId: String(r["organization_id"]),
    memberKey: String(r["member_key"]),
    resourceId: String(r["resource_id"]),
    accountId: String(r["account_id"]),
    pluginId: String(r["plugin_id"]),
    resourceTypeId: String(r["resource_type_id"]),
    status: String(r["status"]),
    leaseId: r["lease_id"] === null ? null : String(r["lease_id"]),
    repairAttempts: Number(r["repair_attempts"] ?? 0),
    expiresAt: new Date(String(r["expires_at"])),
    instanceName: String(r["instance_name"] ?? "environment"),
  }));
}

async function recordRepairFailure(memberId: string, attempts: number, message: string) {
  await db
    .execute(
      sql`
        UPDATE environment_instance_members
        SET repair_attempts = ${attempts + 1},
            repair_error = ${message},
            next_repair_at = now() + ${repairBackoffMs(attempts)}::float8 * interval '1 millisecond',
            updated_at = now()
        WHERE id = ${memberId}
      `,
    )
    .catch((error: unknown) => {
      console.error("[environments] failed to record a repair failure:", error);
    });
}

async function clearRepairError(memberId: string) {
  await db
    .execute(
      sql`
        UPDATE environment_instance_members
        SET repair_error = NULL, updated_at = now()
        WHERE id = ${memberId}
      `,
    )
    .catch(() => undefined);
}

/**
 * Give every stranded member back its TTL. Runs from the poller; the same work
 * is reachable from `GET /instances` as a fast path.
 */
export async function runEnvironmentRepairPass(
  options: EnvironmentRepairPassOptions = {},
): Promise<EnvironmentRepairPassResult> {
  const limit = options.limit ?? 4;
  const claimed = await claimDueRepairs(limit, options.organizationId);
  let repaired = 0;
  let failed = 0;

  for (const member of claimed) {
    try {
      await repairClaimedMember(member);
      await clearRepairError(member.id);
      repaired += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[environments] repair failed for member ${member.memberKey} of instance ${member.instanceId}:`,
        error,
      );
      await recordRepairFailure(member.id, member.repairAttempts, message);
    }
  }
  return { claimed: claimed.length, repaired, failed };
}

/**
 * Close out instances whose members are confirmed gone. Unclaimed on purpose —
 * every write is idempotent, so concurrent replicas converge.
 */
export async function runEnvironmentReconcilePass(
  options: { limit?: number } = {},
): Promise<{ organizations: number }> {
  const limit = options.limit ?? 10;
  const rows = await db.execute(sql`
    SELECT DISTINCT organization_id
    FROM environment_instances
    WHERE status <> 'deleted' AND expires_at <= now()
    LIMIT ${limit}
  `);
  const orgIds = Array.from(rows as Iterable<Record<string, unknown>>, (r) =>
    String(r["organization_id"]),
  );
  for (const organizationId of orgIds) {
    await reconcileEnvironmentInstances(organizationId).catch((error: unknown) => {
      console.error(`[environments] reconcile failed for org ${organizationId}:`, error);
    });
  }
  return { organizations: orgIds.length };
}
