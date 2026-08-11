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
import { and, eq, notInArray } from "drizzle-orm";

import {
  normalizeQuotaUsage,
  quotaUtilization,
  type QuotaCapabilityDeclaration,
} from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { accountQuotaPolls, accountQuotaSnapshots, accountQuotaUsage } from "../db/schema";
import { renderableHelpLink } from "../help-links";
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

  // One transaction for the whole replacement.
  //
  // The three writes below are one fact about the account expressed three
  // ways — what is true now, what was true at this instant, and what is no
  // longer true — and a partial application of them is not a smaller truth but
  // a wrong one. Interrupted between the upserts and the delete, the account
  // keeps a "94% of your Elastic IPs" row for a quota the provider no longer
  // reports; interrupted between the upserts and the snapshots, the trend
  // loses the point that would have explained the jump the current row is
  // already showing. Neither self-corrects: the next pass writes a *new*
  // reading, so the gap in the series is permanent and the stale row survives
  // until the quota reappears or the account is deleted.
  //
  // The whole pass is a handful of statements against three small tables and
  // runs every six hours, so a transaction costs nothing worth measuring.
  await db.transaction(async (tx) => {
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

      await tx
        .insert(accountQuotaUsage)
        .values({ id: randomUUID(), ...values })
        .onConflictDoUpdate({
          target: [accountQuotaUsage.accountId, accountQuotaUsage.quotaKey],
          set: values,
        });

      await tx.insert(accountQuotaSnapshots).values({
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

    // A quota the provider stopped reporting is deleted rather than left at
    // its last reading: a stale "94% of your Elastic IPs" for a quota that no
    // longer applies is worse than showing nothing, because somebody will act
    // on it. The *snapshots* stay — the history of a quota that used to matter
    // is still history, and the retention prune is what eventually removes it.
    //
    // Expressed as one `NOT IN` delete rather than a select-then-delete: read
    // and write in the same statement means there is no window between
    // deciding a row is stale and removing it, and no unbounded id list to
    // ship for an account with many quotas.
    const seen = readings.map((r) => r.id);
    await tx
      .delete(accountQuotaUsage)
      .where(
        seen.length > 0
          ? and(
              eq(accountQuotaUsage.accountId, accountId),
              notInArray(accountQuotaUsage.quotaKey, seen),
            )
          : eq(accountQuotaUsage.accountId, accountId),
      );
  });

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
 * A `QuotaAccessError` is stored with its help link intact so the panel can
 * say "this credential cannot read Service Quotas, here is the policy" rather
 * than reporting a generic outage — those want completely different reactions
 * from the reader, and only one of them is fixable by the reader.
 *
 * Two boundaries around that link, both borrowed from `cost/failure.ts`:
 *
 * - The error is matched **structurally**, not with `instanceof`. Plugins are
 *   bundled with their own copy of `@infrawrench/plugin-base`, so the class
 *   identity a plugin throws is never the one the host imported, and an
 *   `instanceof` check would silently drop every help link a real plugin sends.
 * - The URL goes through `renderableHelpLink`, so only `https:` survives. The
 *   stored value is returned unchanged by the feed and assigned straight to an
 *   anchor's `href`, which makes this write the last place a `javascript:` or
 *   same-origin URL can be stopped.
 */
export async function markQuotaPollFailure(
  accountId: string,
  organizationId: string,
  error: unknown,
  nextPollAt: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const candidate = error as { name?: unknown; helpLabel?: unknown; helpUrl?: unknown } | null;
  const link =
    candidate?.name === "QuotaAccessError"
      ? renderableHelpLink(candidate.helpLabel, candidate.helpUrl)
      : null;
  const help = link
    ? { lastErrorHelpLabel: link.label, lastErrorHelpUrl: link.url }
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
