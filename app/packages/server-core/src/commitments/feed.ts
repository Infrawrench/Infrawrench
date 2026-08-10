/**
 * The commitments feed — everything one screen (or one CLI table, or one MCP
 * call) needs to answer three questions about an org's reservations, savings
 * plans and committed-use discounts:
 *
 *   1. What do we hold? (`holdings`, straight from the collected inventory)
 *   2. Is it working? (per-holding derived utilization, plus coverage as an
 *      honest *range* — see `../commitments/coverage.ts` for why there is no
 *      single denominator)
 *   3. What should we buy next? (`planner` — recommendations that a human
 *      signs off on; nothing here purchases anything)
 *
 * Derivations happen in the pure modules next door; this file only fetches
 * their inputs (Postgres inventory + ClickHouse aggregates) and maps rows.
 *
 * Attribution gating: derived utilization, coverage and the planner only use
 * accounts whose plugin declares `costs.chargeTypes` — for anyone else,
 * every cost row reads as plain uncovered usage and all three numbers would
 * be wrong in the direction that triggers action (a healthy plan at "0%
 * used" gets cancelled). Such accounts still list their holdings; their
 * derived utilization is null with reason `unattributed_rows`, and they are
 * named in `coverage.excludedAccountIds`. Azure's provider-reported
 * utilization is unaffected — it rides on the holding itself and is never
 * blended with anything derived here.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { accountCommitmentPolls, accountCommitments, accounts } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import {
  getAccountDataDays,
  getCommitmentCoverageCells,
  getCommitmentDeliveredTotals,
  getUncoveredDailySpend,
} from "../clickhouse/commitment-readers";
import { computeCommitmentCoverage, type CommitmentCoverageReport } from "./coverage";
import {
  computeCommitmentUtilization,
  type CommitmentUtilizationResult,
  type CommitmentUtilizationUnavailableReason,
} from "./utilization";
import { planCommitmentRecommendations, type PlannerResult } from "./planner";

/** Trailing window coverage and utilization are measured over. */
export const COMMITMENT_UTILIZATION_WINDOW_DAYS = 30;
/** Trailing window the planner sizes recommendations from (min 60 inside). */
export const COMMITMENT_PLANNER_WINDOW_DAYS = 90;

export type HoldingUtilizationReason = CommitmentUtilizationUnavailableReason | "unattributed_rows";

export interface CommitmentHoldingUtilization extends Omit<CommitmentUtilizationResult, "reason"> {
  reason?: HoldingUtilizationReason;
  windowDays: number;
}

export interface CommitmentHolding {
  accountId: string;
  accountName: string;
  pluginId: string;
  commitmentId: string;
  kind: string;
  description: string;
  scope: string | null;
  /** Null means "applies across regions" — render "All regions", not blank. */
  region: string | null;
  startDate: string | null;
  endDate: string | null;
  termDays: number | null;
  paymentOption: string | null;
  currency: string | null;
  upfrontAmount: number | null;
  recurringAmount: number | null;
  recurringPeriod: string | null;
  hourlyCommitmentAmount: number | null;
  unitCommitments: Array<{ unit: string; amount: number }> | null;
  state: string;
  /** The provider's own utilization aggregates (Azure), verbatim. */
  providerUtilization: Array<{ grainDays: number; percentage: number }> | null;
  lastSeenAt: string;
  /** Derived from ingested cost rows; never blended with the above. */
  utilization: CommitmentHoldingUtilization;
}

export interface CommitmentPollFailure {
  accountId: string;
  accountName: string;
  pluginId: string;
  message: string;
  failureCount: number;
}

export interface CommitmentsFeed {
  holdings: CommitmentHolding[];
  coverage: CommitmentCoverageReport;
  planner: PlannerResult;
  failures: CommitmentPollFailure[];
  /** Commitment-capable accounts never yet collected — named, not omitted. */
  pendingAccountIds: string[];
  utilizationWindowDays: number;
  plannerWindowDays: number;
}

const DAY_MS = 86_400_000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBack(to: string, count: number): string[] {
  const end = new Date(`${to}T00:00:00Z`).valueOf();
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    days.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  }
  return days;
}

const STATE_ORDER: Record<string, number> = { active: 0, queued: 1, expired: 2 };

function emptyFeed(): CommitmentsFeed {
  return {
    holdings: [],
    coverage: { available: false, currencies: [], excludedAccountIds: [] },
    planner: {
      available: false,
      windowDayCount: 0,
      recommendations: [],
      rejected: [],
    },
    failures: [],
    pendingAccountIds: [],
    utilizationWindowDays: COMMITMENT_UTILIZATION_WINDOW_DAYS,
    plannerWindowDays: COMMITMENT_PLANNER_WINDOW_DAYS,
  };
}

export async function getCommitmentsFeed(
  organizationId: string,
  now = new Date(),
): Promise<CommitmentsFeed> {
  const plugins = await loadPlugins();
  const commitmentPluginIds = new Set(
    plugins.filter((p) => p.plugin.manifest.commitments).map((p) => p.plugin.manifest.id),
  );
  const chargeTypePluginIds = new Set(
    plugins.filter((p) => p.plugin.manifest.costs?.chargeTypes).map((p) => p.plugin.manifest.id),
  );
  if (commitmentPluginIds.size === 0) return emptyFeed();

  const orgAccounts = await db
    .select({
      id: accounts.id,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
    })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const relevant = orgAccounts.filter((a) => commitmentPluginIds.has(a.pluginId));
  if (relevant.length === 0) return emptyFeed();
  const accountById = new Map(relevant.map((a) => [a.id, a]));

  // Attribution-capable accounts — the only ones coverage, the planner, and
  // derived utilization may read cost rows from. See the module header.
  const attributingAccountIds = relevant
    .filter((a) => chargeTypePluginIds.has(a.pluginId))
    .map((a) => a.id);

  const today = isoDay(now);
  const utilizationDays = daysBack(today, COMMITMENT_UTILIZATION_WINDOW_DAYS);
  const plannerDays = daysBack(today, COMMITMENT_PLANNER_WINDOW_DAYS);
  const utilizationFrom = utilizationDays[0]!;
  const plannerFrom = plannerDays[0]!;

  const relevantIds = relevant.map((a) => a.id);
  const [holdings, polls, coverageCells, dataDays, delivered, uncoveredDaily] = await Promise.all([
    db
      .select()
      .from(accountCommitments)
      .where(eq(accountCommitments.organizationId, organizationId)),
    db
      .select()
      .from(accountCommitmentPolls)
      .where(inArray(accountCommitmentPolls.accountId, relevantIds)),
    getCommitmentCoverageCells(organizationId, utilizationFrom, today, attributingAccountIds),
    getAccountDataDays(organizationId, utilizationFrom, today, attributingAccountIds),
    getCommitmentDeliveredTotals(organizationId, utilizationFrom, today, attributingAccountIds),
    getUncoveredDailySpend(organizationId, plannerFrom, today, attributingAccountIds),
  ]);

  // ── Holdings + derived utilization ────────────────────────────────────
  const deliveredByKey = new Map<string, number>();
  for (const row of delivered) {
    const key = `${row.account_id}\x00${row.commitment_id}`;
    deliveredByKey.set(key, (deliveredByKey.get(key) ?? 0) + row.amount);
  }

  const attributing = new Set(attributingAccountIds);
  const window = { from: utilizationFrom, to: today };
  const mapped: CommitmentHolding[] = holdings
    .filter((h) => accountById.has(h.accountId))
    .map((h) => {
      const account = accountById.get(h.accountId)!;
      const deliveredAmount = deliveredByKey.get(`${h.accountId}\x00${h.commitmentId}`) ?? 0;
      let utilization: CommitmentHoldingUtilization;
      if (h.hourlyCommitmentAmount !== null && !attributing.has(h.accountId)) {
        // Money-denominated but the account's rows carry no attribution:
        // delivered would read 0 and a healthy plan would look cancellable.
        utilization = {
          utilization: null,
          reason: "unattributed_rows",
          obligationAmount: null,
          deliveredAmount: 0,
          activeDays: 0,
          measuredDays: 0,
          missingDays: 0,
          windowDays: COMMITMENT_UTILIZATION_WINDOW_DAYS,
        };
      } else {
        utilization = {
          ...computeCommitmentUtilization({
            hourlyCommitmentAmount: h.hourlyCommitmentAmount,
            startDate: h.startDate?.toISOString() ?? null,
            endDate: h.endDate?.toISOString() ?? null,
            window,
            daysWithData: dataDays.get(h.accountId) ?? new Set(),
            deliveredAmount,
          }),
          windowDays: COMMITMENT_UTILIZATION_WINDOW_DAYS,
        };
      }
      return {
        accountId: h.accountId,
        accountName: account.displayName,
        pluginId: h.pluginId,
        commitmentId: h.commitmentId,
        kind: h.kind,
        description: h.description,
        scope: h.scope,
        region: h.region,
        startDate: h.startDate?.toISOString() ?? null,
        endDate: h.endDate?.toISOString() ?? null,
        termDays: h.termDays,
        paymentOption: h.paymentOption,
        currency: h.currency,
        upfrontAmount: h.upfrontAmount,
        recurringAmount: h.recurringAmount,
        recurringPeriod: h.recurringPeriod,
        hourlyCommitmentAmount: h.hourlyCommitmentAmount,
        unitCommitments: h.unitCommitments,
        state: h.state,
        providerUtilization: h.providerUtilization,
        lastSeenAt: h.lastSeenAt.toISOString(),
        utilization,
      };
    });

  // Active first, then soonest to expire — the reader's next decision is
  // almost always about the thing that lapses next.
  mapped.sort(
    (a, b) =>
      (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3) ||
      (a.endDate ?? "￿").localeCompare(b.endDate ?? "￿") ||
      a.description.localeCompare(b.description),
  );

  // ── Coverage ──────────────────────────────────────────────────────────
  const coverage = computeCommitmentCoverage(
    coverageCells.map((cell) => ({
      accountId: cell.account_id,
      pluginId: cell.plugin_id,
      service: cell.service,
      region: cell.region,
      currency: cell.currency,
      coveredAmount: cell.covered_amount,
      uncoveredAmount: cell.uncovered_amount,
    })),
    relevant.map((a) => ({
      accountId: a.id,
      chargeTypesDeclared: chargeTypePluginIds.has(a.pluginId),
    })),
  );

  // ── Planner ───────────────────────────────────────────────────────────
  const cellMap = new Map<
    string,
    {
      pluginId: string;
      service: string;
      region: string;
      currency: string;
      dailySpend: Map<string, number>;
    }
  >();
  for (const row of uncoveredDaily) {
    const key = [row.plugin_id, row.service, row.region, row.currency].join("\x00");
    let cell = cellMap.get(key);
    if (!cell) {
      cell = {
        pluginId: row.plugin_id,
        service: row.service,
        region: row.region,
        currency: row.currency,
        dailySpend: new Map(),
      };
      cellMap.set(key, cell);
    }
    cell.dailySpend.set(row.day, (cell.dailySpend.get(row.day) ?? 0) + row.amount);
  }
  const planner = planCommitmentRecommendations([...cellMap.values()], plannerDays);

  // ── Failures + pending ────────────────────────────────────────────────
  const failures: CommitmentPollFailure[] = [];
  const polledAccountIds = new Set<string>();
  for (const poll of polls) {
    polledAccountIds.add(poll.accountId);
    const account = accountById.get(poll.accountId);
    if (!account || !poll.lastError) continue;
    failures.push({
      accountId: poll.accountId,
      accountName: account.displayName,
      pluginId: account.pluginId,
      message: poll.lastError,
      failureCount: poll.failureCount,
    });
  }
  const pendingAccountIds = relevant
    .filter((a) => !polledAccountIds.has(a.id))
    .map((a) => a.id)
    .sort();

  return {
    holdings: mapped,
    coverage,
    planner,
    failures,
    pendingAccountIds,
    utilizationWindowDays: COMMITMENT_UTILIZATION_WINDOW_DAYS,
    plannerWindowDays: COMMITMENT_PLANNER_WINDOW_DAYS,
  };
}
