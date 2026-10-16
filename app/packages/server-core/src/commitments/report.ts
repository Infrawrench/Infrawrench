/**
 * Running a commitment report: fetch the inputs, hand them to the pure
 * assembly in `client-core/src/commitment-reports.ts`.
 *
 * Which accounts a report reads is the feed's rule, restated here because it
 * decides whether any number below is honest:
 *
 * - only accounts of a **commitment-capable** plugin (one that lists
 *   holdings): every other provider has nothing to cover, and its spend would
 *   only dilute coverage;
 * - of those, only accounts whose plugin declares **charge types**: without
 *   them every row reads as plain uncovered usage, and coverage, utilization
 *   and savings would all read as zero for a healthy estate. Such providers
 *   (GCP today) are reported as `inventory_only` in the result, named rather
 *   than silently dropped;
 * - and only accounts the caller may see in full (`strictlyVisibleAccountIds`,
 *   the feed's rule for per-account figures). The ClickHouse scan is also
 *   under `costDailyOrgCondition`, so a cost visibility scope narrows it twice.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  buildCommitmentReport,
  commitmentReportRangeProblem,
  isCommitmentReportGroupByCommitment,
  resolveCostDateRange,
  COMMITMENT_REPORT_ON_DEMAND_KEY,
  COMMITMENT_REPORT_UNATTRIBUTED_KEY,
  COMMITMENT_REPORT_UNKNOWN_KIND_KEY,
  type CommitmentKind,
  type CommitmentReportCell,
  type CommitmentReportConfig,
  type CommitmentReportNotice,
  type CommitmentReportOptions,
  type CommitmentReportProvider,
  type CommitmentReportResult,
} from "@infrawrench/client-core";

import { strictlyVisibleAccountIds } from "../cost/visibility-context";
import { isoDay } from "../cost/dates";
import { db } from "../db/client";
import { accountCommitments, accounts } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import {
  getCommitmentReportCells,
  getCommitmentReportDimensionValues,
  type CommitmentReportSplit,
} from "../clickhouse/commitment-readers";

/** A config the server refuses to run (a resolved range past the limits). */
export class CommitmentReportError extends Error {
  override readonly name = "CommitmentReportError";
}

/** Providers whose daily data lands a month's unused commitment fee on one day. */
const LUMPED_UNUSED_PLUGINS = new Set(["aws"]);

interface ReportScope {
  /** Commitment-capable accounts the caller may see, with their plugin. */
  accounts: Array<{ id: string; displayName: string; pluginId: string }>;
  /** The subset whose rows carry coverage attribution. */
  attributing: Set<string>;
  providers: CommitmentReportProvider[];
  pluginNames: Map<string, string>;
}

async function loadReportScope(organizationId: string): Promise<ReportScope> {
  const plugins = await loadPlugins();
  const commitmentPlugins = new Map<string, { displayName: string; chargeTypes: boolean }>();
  for (const p of plugins) {
    const m = p.plugin.manifest;
    if (!m.commitments) continue;
    commitmentPlugins.set(m.id, {
      displayName: m.displayName,
      chargeTypes: Boolean(m.costs?.chargeTypes),
    });
  }
  const pluginNames = new Map([...commitmentPlugins].map(([id, p]) => [id, p.displayName]));
  if (commitmentPlugins.size === 0) {
    return { accounts: [], attributing: new Set(), providers: [], pluginNames };
  }
  const rows = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const visible = strictlyVisibleAccountIds(organizationId);
  const inScope = rows.filter(
    (a) => commitmentPlugins.has(a.pluginId) && (!visible || visible.has(a.id)),
  );
  const attributing = new Set(
    inScope.filter((a) => commitmentPlugins.get(a.pluginId)!.chargeTypes).map((a) => a.id),
  );
  const counts = new Map<string, number>();
  for (const a of inScope) counts.set(a.pluginId, (counts.get(a.pluginId) ?? 0) + 1);
  const providers: CommitmentReportProvider[] = [...counts.entries()]
    .map(([pluginId, accountCount]) => ({
      pluginId,
      displayName: pluginNames.get(pluginId) ?? pluginId,
      status: commitmentPlugins.get(pluginId)!.chargeTypes
        ? ("measured" as const)
        : ("inventory_only" as const),
      accountCount,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { accounts: inScope, attributing, providers, pluginNames };
}

async function loadHoldings(organizationId: string, accountIds: ReadonlySet<string>) {
  const rows = await db
    .select({
      accountId: accountCommitments.accountId,
      pluginId: accountCommitments.pluginId,
      commitmentId: accountCommitments.commitmentId,
      kind: accountCommitments.kind,
      description: accountCommitments.description,
      state: accountCommitments.state,
    })
    .from(accountCommitments)
    .where(eq(accountCommitments.organizationId, organizationId));
  return rows.filter((r) => accountIds.has(r.accountId));
}

/**
 * Run a report config. `today` anchors relative presets, so a saved "last 90
 * days" means the 90 days before each run.
 */
export async function runCommitmentReportConfig(
  organizationId: string,
  config: CommitmentReportConfig,
  today = new Date(),
): Promise<CommitmentReportResult> {
  const { from, to: resolvedTo } = resolveCostDateRange(config.dateRange, today);
  // Never past today: a future day has no spend, and counting it would only
  // add empty buckets.
  const todayIso = isoDay(today);
  const to = resolvedTo > todayIso && from <= todayIso ? todayIso : resolvedTo;
  const problem = commitmentReportRangeProblem(from, to, config.granularity);
  if (problem) throw new CommitmentReportError(problem);

  const scope = await loadReportScope(organizationId);
  const f = config.filters;
  const providers = f.providers?.length ? new Set(f.providers) : null;
  const accountFilter = f.accountIds?.length ? new Set(f.accountIds) : null;
  const filteredAccounts = scope.accounts.filter(
    (a) => (!providers || providers.has(a.pluginId)) && (!accountFilter || accountFilter.has(a.id)),
  );
  const measuredIds = filteredAccounts.filter((a) => scope.attributing.has(a.id)).map((a) => a.id);
  const reportProviders = scope.providers.filter((p) => !providers || providers.has(p.pluginId));

  const holdings = await loadHoldings(organizationId, new Set(filteredAccounts.map((a) => a.id)));
  // A commitment filter selects holdings by type and/or id; covered usage with
  // no id (all of AWS) matches none of them.
  let commitmentIds: string[] | null = null;
  if (f.commitmentTypes?.length || f.commitmentIds?.length) {
    const kinds = f.commitmentTypes?.length ? new Set<string>(f.commitmentTypes) : null;
    const ids = f.commitmentIds?.length ? new Set(f.commitmentIds) : null;
    commitmentIds = [
      ...new Set(
        holdings
          .filter((h) => (!kinds || kinds.has(h.kind)) && (!ids || ids.has(h.commitmentId)))
          .map((h) => h.commitmentId),
      ),
    ];
  }

  const split: CommitmentReportSplit =
    config.groupBy === "commitment_type" ? "commitment" : config.groupBy;
  const rows = await getCommitmentReportCells(organizationId, {
    from,
    to,
    bucket: config.granularity,
    split,
    accountIds: measuredIds,
    services: f.services,
    regions: f.regions,
    commitmentIds,
  });

  const kindById = new Map<string, CommitmentKind>();
  const descriptionById = new Map<string, string>();
  for (const h of holdings) {
    kindById.set(h.commitmentId, h.kind as CommitmentKind);
    descriptionById.set(h.commitmentId, h.description);
  }
  const groupKeyFor = (key: string): string => {
    if (config.groupBy !== "commitment_type") return key;
    if (key === COMMITMENT_REPORT_ON_DEMAND_KEY || key === COMMITMENT_REPORT_UNATTRIBUTED_KEY) {
      return key;
    }
    return kindById.get(key) ?? COMMITMENT_REPORT_UNKNOWN_KIND_KEY;
  };
  const cells: CommitmentReportCell[] = rows.map((r) => ({
    bucket: r.bucket,
    groupKey: groupKeyFor(r.group_key),
    currency: r.currency,
    covered: r.covered,
    coveredAll: r.covered_all,
    unused: r.unused,
    uncovered: r.uncovered,
    uncoveredEligible: r.uncovered_eligible,
    coveredOnDemand: r.covered_on_demand,
    coveredMeasured: r.covered_measured,
  }));

  // Server-side labels for the keys only the server can name. Kinds and the
  // sentinels are named by the clients, which translate them.
  const labels = new Map<string, string>();
  if (config.groupBy === "account") {
    for (const a of scope.accounts) labels.set(a.id, a.displayName);
  } else if (config.groupBy === "provider") {
    for (const [id, name] of scope.pluginNames) labels.set(id, name);
  } else if (config.groupBy === "commitment") {
    for (const [id, description] of descriptionById) labels.set(id, description);
  }

  const notices: CommitmentReportNotice[] = [];
  if (
    config.granularity !== "monthly" &&
    config.granularity !== "quarterly" &&
    filteredAccounts.some(
      (a) => scope.attributing.has(a.id) && LUMPED_UNUSED_PLUGINS.has(a.pluginId),
    )
  ) {
    notices.push("unused_lumped_monthly");
  }
  if (measuredIds.length === 0) notices.push("no_measurable_accounts");

  return buildCommitmentReport(cells, {
    from,
    to,
    granularity: config.granularity,
    groupBy: config.groupBy,
    labels,
    providers: reportProviders,
    notices,
  });
}

/** Trailing window the editor's service and region pickers are drawn from. */
const OPTIONS_WINDOW_DAYS = 180;

/** Picker values for the report editor, scoped exactly as a run is. */
export async function getCommitmentReportOptions(
  organizationId: string,
  today = new Date(),
): Promise<CommitmentReportOptions> {
  const scope = await loadReportScope(organizationId);
  const ids = new Set(scope.accounts.map((a) => a.id));
  const to = isoDay(today);
  const from = isoDay(new Date(today.valueOf() - (OPTIONS_WINDOW_DAYS - 1) * 86_400_000));
  const [holdings, dims] = await Promise.all([
    loadHoldings(organizationId, ids),
    getCommitmentReportDimensionValues(organizationId, from, to, [...scope.attributing]),
  ]);
  return {
    providers: scope.providers.map(({ pluginId, displayName, status }) => ({
      pluginId,
      displayName,
      status,
    })),
    accounts: scope.accounts
      .map((a) => ({ id: a.id, name: a.displayName, pluginId: a.pluginId }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    services: dims.services,
    regions: dims.regions,
    commitments: holdings
      .map((h) => ({
        commitmentId: h.commitmentId,
        accountId: h.accountId,
        pluginId: h.pluginId,
        kind: h.kind as CommitmentKind,
        description: h.description,
        state: h.state,
      }))
      .sort((a, b) => a.description.localeCompare(b.description)),
  };
}
