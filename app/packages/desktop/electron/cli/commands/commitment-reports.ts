// `infrawrench commitments reports [name|id]` and `infrawrench commitments
// report`: saved commitment reports (coverage, utilization, savings over time)
// and an ad-hoc run of the same query. Text output is hand-rolled (tables and
// a sparkline); `--json` prints the server's result as is; `--format csv`
// writes the same CSV the web and desktop "Export CSV" buttons download.
import { writeFileSync } from "node:fs";

import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  CommitmentReport,
  CommitmentReportConfig,
  CommitmentReportGranularity,
  CommitmentReportGroupBy,
  CommitmentReportMetric,
  CommitmentReportNotice,
  CommitmentReportResult,
  CommitmentReportRunResult,
  CommitmentReportSeries,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { parseLastDays, type RangeFlags } from "../args";
import { rangedSparkline, sparkline } from "../charts";
import { matchCostReport } from "../format";
import { c, printJson, println, printTable, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

export interface CommitmentReportCliFlags {
  format?: string | undefined;
  out?: string | undefined;
}

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Commitment reports live in Infrawrench Cloud: they read server-side cost rows and the commitment inventory.",
    );
  }
}

const NOTICE_TEXT: Record<CommitmentReportNotice, string> = {
  unused_lumped_monthly:
    "AWS reports a month's unused commitment on the 1st (or the purchase day): use monthly granularity for AWS utilization.",
  unattributed_commitment_usage:
    "Some covered usage is not tied to a commitment (AWS billing data cannot say which one covered an hour).",
  partial_savings_measurement:
    "Some covered usage has no reported on-demand price and counts as saving nothing: savings are a lower bound.",
  no_measurable_accounts:
    "No account in scope reports covered usage separately: coverage, utilization and savings cannot be measured.",
};

function seriesLabel(core: Core, s: CommitmentReportSeries, groupBy: CommitmentReportGroupBy) {
  if (s.groupKey === core.COMMITMENT_REPORT_ON_DEMAND_KEY) return "on demand (not covered)";
  if (s.groupKey === core.COMMITMENT_REPORT_UNATTRIBUTED_KEY)
    return "covered, commitment not reported";
  if (s.groupKey === core.COMMITMENT_REPORT_UNKNOWN_KIND_KEY) return "commitment not in inventory";
  if (groupBy === "commitment_type" && s.groupKey in core.COMMITMENT_KIND_LABELS) {
    return core.COMMITMENT_KIND_LABELS[s.groupKey as keyof typeof core.COMMITMENT_KIND_LABELS];
  }
  if (groupBy === "none") return "all commitments";
  return s.label || c.dim("(not set)");
}

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function metricText(
  core: Core,
  metric: CommitmentReportMetric,
  value: number | null,
  currency: string,
) {
  if (value === null || !Number.isFinite(value)) return c.dim("—");
  return core.isCommitmentRatioMetric(metric)
    ? `${(value * 100).toFixed(1)}%`
    : money(value, currency);
}

function parseMetric(core: Core, raw: string | undefined, fallback: CommitmentReportMetric) {
  if (!raw) return fallback;
  if (!core.COMMITMENT_REPORT_METRICS.includes(raw as CommitmentReportMetric)) {
    throw new CliError(`--metric must be one of ${core.COMMITMENT_REPORT_METRICS.join(", ")}.`, 2);
  }
  return raw as CommitmentReportMetric;
}

function writeCsv(core: Core, result: CommitmentReportResult, name: string, out?: string) {
  const csv = core.commitmentReportToCsv(result);
  if (out) {
    writeFileSync(out, csv, "utf8");
    println(c.dim(`Wrote ${out}`));
    return;
  }
  process.stdout.write(csv);
  void name;
}

/** Text rendering of one run: providers, notices, headline, sparkline, table. */
function printResult(
  core: Core,
  result: CommitmentReportResult,
  metric: CommitmentReportMetric,
  title: string,
) {
  println(
    `${c.bold(title)} ${c.dim(
      `· ${result.from} to ${result.to} · ${core.COMMITMENT_REPORT_GRANULARITY_LABELS[result.granularity].toLowerCase()}` +
        (result.groupBy !== "none"
          ? ` · by ${core.COMMITMENT_REPORT_GROUP_BY_LABELS[result.groupBy].toLowerCase()}`
          : ""),
    )}`,
  );
  const measured = result.providers.filter((p) => p.status === "measured");
  const inventoryOnly = result.providers.filter((p) => p.status === "inventory_only");
  if (measured.length > 0) {
    println(c.dim(`  measured: ${measured.map((p) => p.displayName).join(", ")}`));
  }
  if (inventoryOnly.length > 0) {
    println(
      c.dim(
        `  not measured (holdings only, cost data has no coverage signal): ${inventoryOnly
          .map((p) => p.displayName)
          .join(", ")}`,
      ),
    );
  }
  for (const n of result.notices) println(c.yellow(`  ${NOTICE_TEXT[n]}`));
  println();

  for (const s of result.overall) {
    const m = s.total.metrics;
    const coverage =
      m.coverage !== null && m.eligibleCoverage !== null && m.eligibleCoverage - m.coverage > 0.0005
        ? `${metricText(core, "coverage", m.coverage, s.currency)}–${metricText(core, "eligibleCoverage", m.eligibleCoverage, s.currency)}`
        : metricText(core, "coverage", m.coverage, s.currency);
    println(
      `${c.bold(s.currency)}  coverage ${coverage}  ·  utilization ${metricText(core, "utilization", m.utilization, s.currency)}  ·  ESR ${metricText(core, "effectiveSavingsRate", m.effectiveSavingsRate, s.currency)}`,
    );
    println(
      c.dim(
        `     net savings ${metricText(core, "netSavings", m.netSavings, s.currency)} · on-demand remainder ${money(m.onDemandRemainder, s.currency)} · commitment ${money(m.commitmentCost, s.currency)} (${money(m.usedCommitmentCost, s.currency)} used, ${money(m.unusedCommitmentCost, s.currency)} unused)`,
      ),
    );
    // Gaps (null) drop out of the sparkline rather than drawing as zero.
    const values = s.points
      .map((p) => p.metrics[metric])
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (values.length > 1) {
      const line = core.isCommitmentRatioMetric(metric)
        ? rangedSparkline(values, 0, Math.max(1, ...values), Math.min(48, values.length))
        : sparkline(values, Math.min(48, values.length));
      println(`     ${core.COMMITMENT_REPORT_METRIC_LABELS[metric]}  ${line}`);
    }
  }
  println();

  const KEY_METRICS: CommitmentReportMetric[] = [
    "coverage",
    "utilization",
    "effectiveSavingsRate",
    "netSavings",
    "onDemandRemainder",
    "usedCommitmentCost",
    "unusedCommitmentCost",
  ];
  type Row = {
    label: string;
    currency: string;
    metrics: CommitmentReportSeries["total"]["metrics"];
  };
  const rows: Row[] =
    result.groupBy === "none"
      ? result.overall.flatMap((s) =>
          s.points.map((p) => ({ label: p.bucket, currency: s.currency, metrics: p.metrics })),
        )
      : result.series.map((s) => ({
          label: seriesLabel(core, s, result.groupBy),
          currency: s.currency,
          metrics: s.total.metrics,
        }));
  if (rows.length === 0) {
    println(c.dim("No commitment or usage spend in this window."));
    return;
  }
  const columns: Column<Row>[] = [
    {
      header:
        result.groupBy === "none"
          ? "period"
          : core.COMMITMENT_REPORT_GROUP_BY_LABELS[result.groupBy].toLowerCase(),
      value: (r) => r.label,
    },
    ...KEY_METRICS.map((m) => ({
      header: core.COMMITMENT_REPORT_METRIC_LABELS[m].toLowerCase(),
      value: (r: Row) => metricText(core, m, r.metrics[m], r.currency),
    })),
  ];
  printTable(rows, columns);
  println(
    c.dim(
      "Amortized basis. A dash means nothing to measure, not zero. --json or --format csv for every metric.",
    ),
  );
}

/** `commitments reports`: list, or run one by name or id. */
export async function cmdCommitmentReports(
  ctx: CliContext,
  query: string,
  range: RangeFlags,
  flags: CommitmentReportCliFlags,
): Promise<void> {
  requireCloud(ctx);
  const core: Core = await import("@infrawrench/client-core");
  const org = await resolveOrg(ctx);
  const reports = await orgFetch<CommitmentReport[]>(org.id, "/commitments/reports");

  if (!query) {
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, reports });
      return;
    }
    if (reports.length === 0) {
      println(
        c.dim(
          "No commitment reports. Create one on the Costs page under Commitments & credits, or run an ad-hoc one with `infrawrench commitments report`.",
        ),
      );
      return;
    }
    const columns: Column<CommitmentReport>[] = [
      { header: "report", value: (r) => r.name },
      { header: "metric", value: (r) => core.COMMITMENT_REPORT_METRIC_LABELS[r.config.metric] },
      {
        header: "granularity",
        value: (r) => core.COMMITMENT_REPORT_GRANULARITY_LABELS[r.config.granularity],
      },
      {
        header: "group by",
        value: (r) => core.COMMITMENT_REPORT_GROUP_BY_LABELS[r.config.groupBy],
      },
      { header: "id", value: (r) => c.dim(r.id) },
    ];
    printTable(reports, columns);
    return;
  }

  const found = matchCostReport(reports, query);
  if (!found.match) {
    throw new CliError(
      found.candidates.length > 1
        ? `"${query}" matches ${found.candidates.length} commitment reports: ${found.candidates.map((r) => r.name).join(", ")}. Use the id.`
        : `No commitment report named "${query}".`,
    );
  }
  const report = found.match;
  const result = await orgFetch<CommitmentReportRunResult>(
    org.id,
    `/commitments/reports/${encodeURIComponent(report.id)}/run`,
    { method: "POST", body: "{}" },
  );
  if (flags.format === "csv") {
    writeCsv(core, result, report.name, flags.out);
    return;
  }
  if (flags.format) throw new CliError("--format takes csv for commitment reports.", 2);
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...result });
    return;
  }
  printResult(core, result, parseMetric(core, range.metric, report.config.metric), report.name);
}

const BINS: Record<string, CommitmentReportGranularity> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  quarter: "quarterly",
};

/**
 * `commitments report`: an unsaved run. `--last 90d` (or `--from/--to`),
 * `--bin day|week|month|quarter`, `--group-by`, `--provider`, `-a` for one
 * account, `--metric` for the sparkline.
 */
export async function cmdCommitmentReportQuery(
  ctx: CliContext,
  range: RangeFlags,
  provider: string | undefined,
  flags: CommitmentReportCliFlags,
): Promise<void> {
  requireCloud(ctx);
  const core: Core = await import("@infrawrench/client-core");
  if (range.bin === "hour") {
    throw new CliError(
      "Hourly is not available: spend is collected one row per day, so an hourly bucket would be invented.",
      2,
    );
  }
  const granularity = range.bin ? BINS[range.bin] : "weekly";
  if (!granularity) throw new CliError("--bin takes day, week, month or quarter.", 2);
  const groupBy = (range.groupBy ?? "none") as CommitmentReportGroupBy;
  if (!core.COMMITMENT_REPORT_GROUP_BYS.includes(groupBy)) {
    throw new CliError(`--group-by takes ${core.COMMITMENT_REPORT_GROUP_BYS.join(", ")}.`, 2);
  }
  const metric = parseMetric(core, range.metric, "coverage");
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const to = range.to ?? isoDay(Date.now());
  const days = range.last ? Math.max(1, Math.round(parseLastDays(range.last))) : 90;
  const from = range.from ?? isoDay(Date.parse(to) - (days - 1) * 86_400_000);
  const org = await resolveOrg(ctx);

  const filters: CommitmentReportConfig["filters"] = {};
  if (provider) filters.providers = [provider];
  if (ctx.flags.account) {
    const options = await orgFetch<{ accounts: Array<{ id: string; name: string }> }>(
      org.id,
      "/commitments/report-options",
    );
    const want = ctx.flags.account.toLowerCase();
    const account = options.accounts.find(
      (a) => a.id === ctx.flags.account || a.name.toLowerCase() === want,
    );
    if (!account) throw new CliError(`No commitment-capable account "${ctx.flags.account}".`);
    filters.accountIds = [account.id];
  }
  const config: CommitmentReportConfig = {
    version: 1,
    dateRange: { kind: "absolute", from, to },
    granularity,
    groupBy,
    filters,
    metric,
  };
  const result = await orgFetch<CommitmentReportResult>(org.id, "/commitments/report-query", {
    method: "POST",
    body: JSON.stringify(config),
  });
  if (flags.format === "csv") {
    writeCsv(core, result, "commitment-report", flags.out);
    return;
  }
  if (flags.format) throw new CliError("--format takes csv for commitment reports.", 2);
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, config, ...result });
    return;
  }
  printResult(core, result, metric, org.displayName);
}
