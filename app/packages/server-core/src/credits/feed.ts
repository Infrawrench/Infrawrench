/**
 * The credit burndown feed — every prepaid pot an org holds, with its burn
 * rate and runway.
 *
 * The reason this is a screen at all: a provider that bills in arrears sends
 * an invoice you can argue with, but a prepaid pot that empties simply stops
 * answering. Running out of DeepSeek credit is an outage, not a bill — and the
 * balance on its own is not actionable. "You have $42" tells you nothing;
 * "$42, six days left at your current burn" is a decision.
 */
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";

import { db } from "../db/client";
import {
  accountCreditBalances,
  accountCreditPolls,
  accountCreditSnapshots,
  accounts,
} from "../db/schema";
import { loadPlugins } from "../plugin-loader";

import {
  estimateBurn,
  estimateRunway,
  runwayUrgency,
  type BurnEstimate,
  type RunwayEstimate,
  type RunwayUrgency,
} from "./burn";

/** How far back the burn estimate looks. */
export const BURN_WINDOW_DAYS = 30;

export interface CreditPot {
  accountId: string;
  accountName: string;
  pluginId: string;
  /** The provider's own word for this pot ("Credits", "Balance"). */
  capabilityLabel: string;
  /** Where the user tops up, when the plugin declares it. */
  topUpUrl: string | null;
  potKey: string;
  label: string;
  remaining: number;
  currency: string;
  granted: number | null;
  /** Hard expiry on the credit itself, independent of burn. */
  creditExpiresAt: string | null;
  observedAt: string;
  burnPerDay: number | null;
  burnSpanDays: number;
  observations: number;
  topUps: number;
  runwayDays: number | null;
  exhaustedAt: string | null;
  neverEmpties: boolean;
  /** True when the credit's own expiry, not the burn, is the deadline. */
  limitedByExpiry: boolean;
  urgency: RunwayUrgency;
}

/** An account whose balance could not be read, and why. */
export interface CreditPollFailure {
  accountId: string;
  accountName: string;
  pluginId: string;
  error: string;
  helpLabel: string | null;
  helpUrl: string | null;
  failureCount: number;
}

export interface CreditBurndownFeed {
  pots: CreditPot[];
  failures: CreditPollFailure[];
  /**
   * Accounts on a credit-capable plugin that have never been collected. Named
   * rather than omitted: an empty screen that should have had rows on it is a
   * bug the user can see and we cannot.
   */
  pendingAccountIds: string[];
  burnWindowDays: number;
}

/**
 * Every pot the org holds, most urgent first.
 *
 * Sorted by urgency and then by days remaining, so the thing about to break is
 * the first row — not the biggest balance, which is the sort a "credits" screen
 * would naively pick and which buries exactly the account that needs attention.
 */
export async function getCreditBurndown(
  organizationId: string,
  now = new Date(),
): Promise<CreditBurndownFeed> {
  const plugins = await loadPlugins();
  const creditPlugins = new Map(
    plugins
      .filter((p) => p.plugin.manifest.credits)
      .map((p) => [p.plugin.manifest.id, p.plugin.manifest.credits!]),
  );
  if (creditPlugins.size === 0) {
    return { pots: [], failures: [], pendingAccountIds: [], burnWindowDays: BURN_WINDOW_DAYS };
  }

  const orgAccounts = await db
    .select({
      id: accounts.id,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId));
  const relevant = orgAccounts.filter((a) => creditPlugins.has(a.pluginId));
  if (relevant.length === 0) {
    return { pots: [], failures: [], pendingAccountIds: [], burnWindowDays: BURN_WINDOW_DAYS };
  }
  const accountById = new Map(relevant.map((a) => [a.id, a]));

  const since = new Date(now.getTime() - BURN_WINDOW_DAYS * 86_400_000);
  const [balances, snapshots, polls] = await Promise.all([
    db
      .select()
      .from(accountCreditBalances)
      .where(eq(accountCreditBalances.organizationId, organizationId)),
    db
      .select({
        accountId: accountCreditSnapshots.accountId,
        potKey: accountCreditSnapshots.potKey,
        remaining: accountCreditSnapshots.remaining,
        observedAt: accountCreditSnapshots.observedAt,
      })
      .from(accountCreditSnapshots)
      .where(
        and(
          eq(accountCreditSnapshots.organizationId, organizationId),
          gte(accountCreditSnapshots.observedAt, since),
        ),
      )
      .orderBy(asc(accountCreditSnapshots.observedAt)),
    db
      .select()
      .from(accountCreditPolls)
      .where(eq(accountCreditPolls.organizationId, organizationId)),
  ]);

  const seriesByPot = new Map<string, Array<{ at: number; remaining: number }>>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.accountId}:${snapshot.potKey}`;
    const list = seriesByPot.get(key);
    const point = { at: snapshot.observedAt.getTime(), remaining: snapshot.remaining };
    if (list) list.push(point);
    else seriesByPot.set(key, [point]);
  }

  const pots: CreditPot[] = [];
  for (const row of balances) {
    const account = accountById.get(row.accountId);
    if (!account) continue;
    const capability = creditPlugins.get(account.pluginId);
    const burn: BurnEstimate = estimateBurn(
      seriesByPot.get(`${row.accountId}:${row.potKey}`) ?? [],
    );
    const runway: RunwayEstimate = estimateRunway(row.remaining, burn, {
      now: now.getTime(),
      creditExpiresAt: row.creditExpiresAt?.toISOString() ?? null,
    });

    pots.push({
      accountId: row.accountId,
      accountName: account.displayName,
      pluginId: account.pluginId,
      capabilityLabel: capability?.label ?? "Credits",
      topUpUrl: capability?.topUpUrl ?? null,
      potKey: row.potKey,
      label: row.label,
      remaining: row.remaining,
      currency: row.currency,
      granted: row.granted,
      creditExpiresAt: row.creditExpiresAt?.toISOString() ?? null,
      observedAt: row.observedAt.toISOString(),
      burnPerDay: burn.perDay,
      burnSpanDays: burn.spanDays,
      observations: burn.observations,
      topUps: burn.topUps,
      runwayDays: runway.days,
      exhaustedAt: runway.exhaustedAt,
      neverEmpties: runway.neverEmpties,
      limitedByExpiry: runway.limitedByExpiry,
      urgency: runwayUrgency(runway),
    });
  }

  const URGENCY_ORDER: Record<RunwayUrgency, number> = {
    critical: 0,
    warning: 1,
    unknown: 2,
    ok: 3,
  };
  pots.sort(
    (a, b) =>
      URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] ||
      (a.runwayDays ?? Infinity) - (b.runwayDays ?? Infinity) ||
      a.accountName.localeCompare(b.accountName),
  );

  const failures: CreditPollFailure[] = [];
  const collected = new Set(balances.map((b) => b.accountId));
  const polled = new Set<string>();
  for (const poll of polls) {
    polled.add(poll.accountId);
    const account = accountById.get(poll.accountId);
    if (!account || !poll.lastError) continue;
    failures.push({
      accountId: poll.accountId,
      accountName: account.displayName,
      pluginId: account.pluginId,
      error: poll.lastError,
      helpLabel: poll.lastErrorHelpLabel,
      helpUrl: poll.lastErrorHelpUrl,
      failureCount: poll.failureCount,
    });
  }

  return {
    pots,
    failures,
    pendingAccountIds: relevant
      .filter((a) => !collected.has(a.id) && !polled.has(a.id))
      .map((a) => a.id),
    burnWindowDays: BURN_WINDOW_DAYS,
  };
}

/**
 * Prune credit snapshots older than the burn window plus a margin.
 *
 * The margin is a year rather than the 30-day window: the series is a few
 * thousand tiny rows and keeping a year of it costs nothing, while a longer
 * history is the only way to answer "what did this cost us last quarter" if
 * anybody ever asks. Called from the poller's hourly retention slot.
 */
export async function pruneCreditSnapshots(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 365 * 86_400_000);
  let deleted = 0;
  // Batched like every other prune here: a first run against a long-neglected
  // table must not hold locks (or a `returning()` array) for minutes. Whatever
  // is left goes on the next pass an hour later.
  for (let batch = 0; batch < MAX_SNAPSHOT_PRUNE_BATCHES; batch++) {
    const due = await db
      .select({ id: accountCreditSnapshots.id })
      .from(accountCreditSnapshots)
      .where(lt(accountCreditSnapshots.observedAt, cutoff))
      .limit(SNAPSHOT_PRUNE_BATCH_SIZE);
    if (due.length === 0) break;
    await db.delete(accountCreditSnapshots).where(
      inArray(
        accountCreditSnapshots.id,
        due.map((r) => r.id),
      ),
    );
    deleted += due.length;
    if (due.length < SNAPSHOT_PRUNE_BATCH_SIZE) break;
  }
  return deleted;
}

const SNAPSHOT_PRUNE_BATCH_SIZE = 2_000;
const MAX_SNAPSHOT_PRUNE_BATCHES = 25;
