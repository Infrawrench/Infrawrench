/**
 * Collect the commitment inventory for one account.
 *
 * Deliberately parallel to `credits/collect.ts`: the host owns scheduling,
 * storage and rendering; the plugin owns the provider calls. A collection is
 * a full snapshot — the provider's list APIs return the entire holding,
 * expired records included — so storage is an upsert per record plus a sweep
 * of rows the provider stopped reporting. A commitment that vanished from
 * the provider (account access moved, record aged out) is deleted rather
 * than left at its last reading: stale holdings are exactly what a coverage
 * number must not be built on.
 */
import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";

import type { CommitmentsCapabilityDeclaration } from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { accountCommitmentPolls, accountCommitments } from "../db/schema";
import { loadAccountClient } from "../sync-resources";

export interface CommitmentCollectionResult {
  /** Records the provider reported. */
  recordCount: number;
}

/**
 * Fetch and store the account's commitments.
 *
 * Throws on failure — the caller (the poller's commitments pass) owns backoff
 * and the error write, exactly as the cost and credits passes do. The plugin
 * side has the same contract (a per-region failure fails the whole fetch), so
 * a partial provider outage never masquerades as commitments having ended.
 */
export async function collectAccountCommitments(
  accountId: string,
  organizationId: string,
): Promise<CommitmentCollectionResult> {
  const { account, plugin, client } = await loadAccountClient(accountId, organizationId);

  const capability: CommitmentsCapabilityDeclaration | undefined = plugin.manifest.commitments;
  if (!capability || !client.fetchCommitments) {
    throw new Error(`Plugin "${account.pluginId}" does not list commitments`);
  }

  const records = await client.fetchCommitments(accountId);
  const collectedAt = new Date();

  for (const record of records) {
    const values = {
      organizationId,
      accountId,
      pluginId: account.pluginId,
      commitmentId: record.id,
      kind: record.kind,
      description: record.description,
      scope: record.scope ?? null,
      region: record.region ?? null,
      startDate: record.startDate ? new Date(record.startDate) : null,
      endDate: record.endDate ? new Date(record.endDate) : null,
      termDays: record.termDays ?? null,
      paymentOption: record.paymentOption ?? null,
      // Money fields stay NULL when unreported — "not reported" and "free"
      // must never render the same.
      currency: record.currency ?? null,
      upfrontAmount: record.upfrontAmount ?? null,
      recurringAmount: record.recurringAmount ?? null,
      recurringPeriod: record.recurringPeriod ?? null,
      hourlyCommitmentAmount: record.hourlyCommitmentAmount ?? null,
      unitCommitments: record.unitCommitments ?? null,
      state: record.state,
      providerUtilization: record.providerUtilization ?? null,
      lastSeenAt: collectedAt,
      updatedAt: collectedAt,
    };
    await db
      .insert(accountCommitments)
      .values({ id: randomUUID(), ...values })
      .onConflictDoUpdate({
        target: [accountCommitments.accountId, accountCommitments.commitmentId],
        set: values,
      });
  }

  // Sweep records this collection did not see. Safe because the fetch either
  // returned the provider's full holding or threw before reaching here.
  await db
    .delete(accountCommitments)
    .where(
      and(
        eq(accountCommitments.accountId, accountId),
        lt(accountCommitments.lastSeenAt, collectedAt),
      ),
    );

  return { recordCount: records.length };
}

/** Record a successful collection: clear the error, schedule the next read. */
export async function markCommitmentPollSuccess(
  accountId: string,
  organizationId: string,
  nextPollAt: Date,
): Promise<void> {
  const values = {
    organizationId,
    lastPolledAt: new Date(),
    nextPollAt,
    failureCount: 0,
    lastError: null,
  };
  await db
    .insert(accountCommitmentPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountCommitmentPolls.accountId, set: values });
}

/** Record a failure and back off; the panel shows the message verbatim. */
export async function markCommitmentPollFailure(
  accountId: string,
  organizationId: string,
  error: unknown,
  nextPollAt: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  const [existing] = await db
    .select({ failureCount: accountCommitmentPolls.failureCount })
    .from(accountCommitmentPolls)
    .where(eq(accountCommitmentPolls.accountId, accountId))
    .limit(1);

  const values = {
    organizationId,
    nextPollAt,
    failureCount: (existing?.failureCount ?? 0) + 1,
    lastError: message.slice(0, 500),
  };
  await db
    .insert(accountCommitmentPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountCommitmentPolls.accountId, set: values });
}
