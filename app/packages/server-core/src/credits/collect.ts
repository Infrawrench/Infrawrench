/**
 * Collect prepaid credit balances for one account.
 *
 * Deliberately parallel to `cost/collect.ts`: the host owns scheduling,
 * storage and rendering; the plugin owns the one provider call. What differs
 * is that a balance is a point-in-time reading rather than a backfillable
 * series, so there is no history to fetch — the series is the one we build by
 * reading repeatedly, which is why every collection appends a snapshot even
 * when the number has not moved. A flat stretch is evidence of an idle
 * account, and dropping it would make an idle pot indistinguishable from an
 * uncollected one.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { CreditAccessError, type CreditsCapabilityDeclaration } from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { accountCreditBalances, accountCreditPolls, accountCreditSnapshots } from "../db/schema";
import { loadAccountClient } from "../sync-resources";

export interface CreditCollectionResult {
  /** Pots read from the provider. */
  potCount: number;
}

/**
 * Read the account's balances and record them.
 *
 * Throws on failure — the caller (the poller's credits pass) owns backoff and
 * the error write, exactly as the cost pass does.
 */
export async function collectAccountCredits(
  accountId: string,
  organizationId: string,
): Promise<CreditCollectionResult> {
  const { account, plugin, client } = await loadAccountClient(accountId, organizationId);

  const capability: CreditsCapabilityDeclaration | undefined = plugin.manifest.credits;
  if (!capability || !client.fetchCreditBalance) {
    throw new Error(`Plugin "${account.pluginId}" does not report a credit balance`);
  }

  const balances = await client.fetchCreditBalance(accountId);
  const observedAt = new Date();

  for (const balance of balances) {
    const potKey = balance.key || "default";
    const values = {
      organizationId,
      accountId,
      potKey,
      label: balance.label || capability.label || "Credits",
      remaining: balance.remaining,
      currency: balance.currency || "USD",
      granted: balance.granted ?? null,
      creditExpiresAt: balance.expiresAt ? new Date(balance.expiresAt) : null,
      observedAt,
    };

    await db
      .insert(accountCreditBalances)
      .values({ id: randomUUID(), ...values })
      .onConflictDoUpdate({
        target: [accountCreditBalances.accountId, accountCreditBalances.potKey],
        set: values,
      });

    await db.insert(accountCreditSnapshots).values({
      id: randomUUID(),
      organizationId,
      accountId,
      potKey,
      remaining: balance.remaining,
      currency: balance.currency || "USD",
      observedAt,
    });
  }

  // A pot the provider stopped reporting is deleted rather than left at its
  // last reading: a stale "$40 remaining" for credit that has been consumed or
  // withdrawn is worse than showing nothing, because somebody will plan
  // against it.
  const seen = new Set(balances.map((b) => b.key || "default"));
  const existing = await db
    .select({ id: accountCreditBalances.id, potKey: accountCreditBalances.potKey })
    .from(accountCreditBalances)
    .where(eq(accountCreditBalances.accountId, accountId));
  for (const row of existing) {
    if (!seen.has(row.potKey)) {
      await db
        .delete(accountCreditBalances)
        .where(
          and(
            eq(accountCreditBalances.accountId, accountId),
            eq(accountCreditBalances.potKey, row.potKey),
          ),
        );
    }
  }

  return { potCount: balances.length };
}

/** Record a successful collection: clear the error, schedule the next read. */
export async function markCreditPollSuccess(
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
    .insert(accountCreditPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountCreditPolls.accountId, set: values });
}

/**
 * Record a failure and back off.
 *
 * A {@link CreditAccessError} is stored with its help link intact so the panel
 * can say "this key cannot see the balance, here is how to fix it" rather than
 * reporting a generic outage — those want completely different reactions from
 * the reader.
 */
export async function markCreditPollFailure(
  accountId: string,
  organizationId: string,
  error: unknown,
  nextPollAt: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const help =
    error instanceof CreditAccessError && error.helpLabel && error.helpUrl
      ? { lastErrorHelpLabel: error.helpLabel, lastErrorHelpUrl: error.helpUrl }
      : { lastErrorHelpLabel: null, lastErrorHelpUrl: null };

  const [existing] = await db
    .select({ failureCount: accountCreditPolls.failureCount })
    .from(accountCreditPolls)
    .where(eq(accountCreditPolls.accountId, accountId))
    .limit(1);

  const values = {
    organizationId,
    nextPollAt,
    failureCount: (existing?.failureCount ?? 0) + 1,
    lastError: message.slice(0, 500),
    ...help,
  };
  await db
    .insert(accountCreditPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountCreditPolls.accountId, set: values });
}
