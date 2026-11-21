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
 *   the feed's rule for per-account figures). The scan is also under
 *   `costDailyOrgCondition`, so a cost visibility scope narrows it twice.
 *
 * A config reaching here has been decoded by the request schema, whose limits
 * are set so that every relative preset fits every granularity: a run is
 * never refused. The check below only guards against a stored row that no
 * longer meets a later, tighter limit.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  buildCommitmentReport,
  commitmentReportRangeProblem,
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
} from "../analytics/commitment-readers";

/** What the report needs to know about a commitment-capable plugin, from its manifest. */
interface CommitmentPlugin {
  displayName: string;
  /** Cost rows tell covered usage apart (`costs.chargeTypes`). */
  measured: boolean;
  /** Daily data books a month's unused fee on one day (`commitments.unusedFeeBookedMonthly`). */
  unusedFeeBookedMonthly: boolean;
}

interface ReportScope {
  /** Commitment-capable accounts the caller may see, with their plugin. */
  accounts: Array<{ id: string; displayName: string; pluginId: string }>;
  plugins: ReadonlyMap<string, CommitmentPlugin>;
  providers: CommitmentReportProvider[];
}

async function loadReportScope(organizationId: string): Promise<ReportScope> {
  const plugins = new Map<string, CommitmentPlugin>();
  for (const { plugin } of await loadPlugins()) {
    const m = plugin.manifest;
    if (!m.commitments) continue;
    plugins.set(m.id, {
      displayName: m.displayName,
      measured: Boolean(m.costs?.chargeTypes),
      unusedFeeBookedMonthly: m.commitments.unusedFeeBookedMonthly === true,
    });
  }
  if (plugins.size === 0) return { accounts: [], plugins, providers: [] };
  const rows = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const visible = strictlyVisibleAccountIds(organizationId);
  const inScope = rows.filter((a) => plugins.has(a.pluginId) && (!visible || visible.has(a.id)));
  const counts = new Map<string, number>();
  for (const a of inScope) counts.set(a.pluginId, (counts.get(a.pluginId) ?? 0) + 1);
  const providers: CommitmentReportProvider[] = [...counts.entries()]
    .map(([pluginId, accountCount]) => {
      const p = plugins.get(pluginId)!;
      return {
        pluginId,
        displayName: p.displayName,
        status: p.measured ? ("measured" as const) : ("inventory_only" as const),
        accountCount,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { accounts: inScope, plugins, providers };
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
  if (problem) throw new Error(`Commitment report config out of bounds: ${problem}`);

  const scope = await loadReportScope(organizationId);
  const f = config.filters;
  const providerFilter = f.providers ? new Set(f.providers) : null;
  const accountFilter = f.accountIds ? new Set(f.accountIds) : null;
  const filteredAccounts = scope.accounts.filter(
    (a) =>
      (!providerFilter || providerFilter.has(a.pluginId)) &&
      (!accountFilter || accountFilter.has(a.id)),
  );
  const measuredAccounts = filteredAccounts.filter((a) => scope.plugins.get(a.pluginId)!.measured);
  const reportProviders = scope.providers.filter(
    (p) => !providerFilter || providerFilter.has(p.pluginId),
  );

  const holdings = await loadHoldings(organizationId, new Set(filteredAccounts.map((a) => a.id)));
  // A commitment filter selects holdings by type and/or id; covered usage with
  // no id (all of AWS) matches none of them.
  let commitmentIds: string[] | null = null;
  if (f.commitmentTypes || f.commitmentIds) {
    const kinds = f.commitmentTypes ? new Set<string>(f.commitmentTypes) : null;
    const ids = f.commitmentIds ? new Set(f.commitmentIds) : null;
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
    accountIds: measuredAccounts.map((a) => a.id),
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
    for (const [id, p] of scope.plugins) labels.set(id, p.displayName);
  } else if (config.groupBy === "commitment") {
    for (const [id, description] of descriptionById) labels.set(id, description);
  }

  const notices: CommitmentReportNotice[] = [];
  if (
    (config.granularity === "daily" || config.granularity === "weekly") &&
    measuredAccounts.some((a) => scope.plugins.get(a.pluginId)!.unusedFeeBookedMonthly)
  ) {
    notices.push("unused_lumped_monthly");
  }
  if (measuredAccounts.length === 0) notices.push("no_measurable_accounts");

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
  const measuredIds = scope.accounts
    .filter((a) => scope.plugins.get(a.pluginId)!.measured)
    .map((a) => a.id);
  const to = isoDay(today);
  const from = isoDay(new Date(today.valueOf() - (OPTIONS_WINDOW_DAYS - 1) * 86_400_000));
  const [holdings, dims] = await Promise.all([
    loadHoldings(organizationId, ids),
    getCommitmentReportDimensionValues(organizationId, from, to, measuredIds),
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
