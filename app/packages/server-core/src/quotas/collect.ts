/**
 * Collect quota readings for one account.
 *
 * Deliberately parallel to `credits/collect.ts`: the host owns scheduling,
 * storage and rendering; the plugin owns the provider calls. A quota, like a
 * balance, is a point-in-time reading with no backfillable history — the
 * series is the one we build by reading repeatedly, which is why every
 * collection appends a snapshot even when nothing has moved. A flat stretch is
 * evidence of a stable account, and dropping it would make a stable quota
 * indistinguishable from an uncollected one.
 *
 * The one thing that differs from credits: the *limit* is written on every
 * snapshot as well as on the current row. A quota's ceiling moves when a
 * support ticket is approved, and a trend computed against today's limit would
 * silently rewrite last week's utilisation the moment it did.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import {
  normalizeQuotaUsage,
  QuotaAccessError,
  quotaUtilization,
  type QuotaCapabilityDeclaration,
} from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { accountQuotaPolls, accountQuotaSnapshots, accountQuotaUsage } from "../db/schema";
import { loadAccountClient } from "../sync-resources";

export interface QuotaCollectionResult {
  /** Quotas read from the provider, after the contract's normalisation. */
  quotaCount: number;
  /** Readings the plugin returned that normalisation dropped (unusable limits). */
  droppedCount: number;
}

/**
 * Read the account's quotas and record them.
 *
 * Throws on failure — the caller (the poller's quota pass) owns backoff and
 * the error write, exactly as the cost and credit passes do.
 */
export async function collectAccountQuotas(
  accountId: string,
  organizationId: string,
): Promise<QuotaCollectionResult> {
  const { account, plugin, client } = await loadAccountClient(accountId, organizationId);

  const capability: QuotaCapabilityDeclaration | undefined = plugin.manifest.quotas;
  if (!capability || !client.fetchQuotas) {
    throw new Error(`Plugin "${account.pluginId}" does not report quotas`);
  }

  const raw = await client.fetchQuotas(accountId);
  const readings = normalizeQuotaUsage(raw);
  const observedAt = new Date();

  for (const reading of readings) {
    const utilization = quotaUtilization(reading.used, reading.limit);
    const values = {
      organizationId,
      accountId,
      quotaKey: reading.id,
      service: reading.service,
      name: reading.name,
      // Empty string is not a region. Plugins that build the field by
      // concatenation produce one, and storing it would render as a region
      // chip with nothing in it.
      region: reading.region && reading.region.length > 0 ? reading.region : null,
      quotaLimit: reading.limit,
      used: reading.used,
      utilization,
      unit: reading.unit ?? null,
      adjustable: reading.adjustable ?? null,
      docsUrl: reading.docsUrl ?? null,
      observedAt,
    };

    await db
      .insert(accountQuotaUsage)
      .values({ id: randomUUID(), ...values })
      .onConflictDoUpdate({
        target: [accountQuotaUsage.accountId, accountQuotaUsage.quotaKey],
        set: values,
      });

    await db.insert(accountQuotaSnapshots).values({
      id: randomUUID(),
      organizationId,
      accountId,
      quotaKey: reading.id,
      quotaLimit: reading.limit,
      used: reading.used,
      utilization,
      observedAt,
    });
  }

  // A quota the provider stopped reporting is deleted rather than left at its
  // last reading: a stale "94% of your Elastic IPs" for a quota that no longer
  // applies is worse than showing nothing, because somebody will act on it.
  // The *snapshots* stay — the history of a quota that used to matter is still
  // history, and the retention prune is what eventually removes it.
  const seen = new Set(readings.map((r) => r.id));
  const existing = await db
    .select({ id: accountQuotaUsage.id, quotaKey: accountQuotaUsage.quotaKey })
    .from(accountQuotaUsage)
    .where(eq(accountQuotaUsage.accountId, accountId));
  const stale = existing.filter((row) => !seen.has(row.quotaKey)).map((row) => row.id);
  if (stale.length > 0) {
    await db
      .delete(accountQuotaUsage)
      .where(and(eq(accountQuotaUsage.accountId, accountId), inArray(accountQuotaUsage.id, stale)));
  }

  return { quotaCount: readings.length, droppedCount: raw.length - readings.length };
}

/** Record a successful collection: clear the error, schedule the next read. */
export async function markQuotaPollSuccess(
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
    lastErrorHelpLabel: null,
    lastErrorHelpUrl: null,
  };
  await db
    .insert(accountQuotaPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountQuotaPolls.accountId, set: values });
}

/**
 * Record a failure and back off.
 *
 * A {@link QuotaAccessError} is stored with its help link intact so the panel
 * can say "this credential cannot read Service Quotas, here is the policy"
 * rather than reporting a generic outage — those want completely different
 * reactions from the reader, and only one of them is fixable by the reader.
 */
export async function markQuotaPollFailure(
  accountId: string,
  organizationId: string,
  error: unknown,
  nextPollAt: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const help =
    error instanceof QuotaAccessError && error.helpLabel && error.helpUrl
      ? { lastErrorHelpLabel: error.helpLabel, lastErrorHelpUrl: error.helpUrl }
      : { lastErrorHelpLabel: null, lastErrorHelpUrl: null };

  const [existing] = await db
    .select({ failureCount: accountQuotaPolls.failureCount })
    .from(accountQuotaPolls)
    .where(eq(accountQuotaPolls.accountId, accountId))
    .limit(1);

  const values = {
    organizationId,
    nextPollAt,
    failureCount: (existing?.failureCount ?? 0) + 1,
    lastError: message.slice(0, 500),
    ...help,
  };
  await db
    .insert(accountQuotaPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountQuotaPolls.accountId, set: values });
}
