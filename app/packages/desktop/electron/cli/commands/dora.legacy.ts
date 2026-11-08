// `infrawrench dora`: the four DORA metrics for production, with their bands,
// the previous period, a sparkline trend per metric and a breakdown by any
// scope dimension. `dora changes` is the drill-down (with `--failed`),
// `dora restores` the recoveries, `dora settings` what counts as production.
//
// Cloud-only: deploy events and incidents live in the cloud. Types come from
// `@infrawrench/client-core` type-only; formatting and bands are loaded with a
// dynamic import, the main project's rule for client-core runtime code. Zero
// new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  DoraBand,
  DoraChange,
  DoraChangesResponse,
  DoraMetric,
  DoraQuery,
  DoraReport,
  DoraRestoresResponse,
  DoraSettingsView,
  DoraSummary,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe, type Column } from "../output";
import { sparkline } from "../charts";
import { parseLastDays, type RangeFlags } from "../args";
import { formatChangeTime } from "../format";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

export interface DoraFlags {
  scope: string | undefined;
  failed: boolean;
}

const DAY_MS = 86_400_000;

/** `--from`/`--to` (dates or timestamps) win; `--last`/`--days` size the window ending now. */
export function doraWindow(range: RangeFlags, now = Date.now()): { from: string; to: string } {
  const parse = (v: string, flag: string): number => {
    const t = Date.parse(v);
    if (!Number.isFinite(t))
      throw new CliError(`Invalid --${flag} "${v}": use YYYY-MM-DD or an ISO timestamp`, 2);
    return t;
  };
  const to = range.to ? parse(range.to, "to") : now;
  const days = range.days ?? (range.last ? Math.max(1, Math.round(parseLastDays(range.last))) : 30);
  const from = range.from ? parse(range.from, "from") : to - days * DAY_MS;
  if (from >= to) throw new CliError("--from must be before --to", 2);
  if (to - from > 366 * DAY_MS) throw new CliError("The range is at most 366 days", 2);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** `--scope owner=user:abc` filters to one value; `--scope owner` to "not known". */
export function parseDoraScope(scope: string | undefined): Pick<DoraQuery, "dimension" | "value"> {
  if (!scope) return {};
  const eq = scope.indexOf("=");
  if (eq < 0) return { dimension: scope.trim(), value: null };
  const dimension = scope.slice(0, eq).trim();
  const value = scope.slice(eq + 1).trim();
  if (!dimension) throw new CliError(`Invalid --scope "${scope}": use <dimension>=<value>`, 2);
  return { dimension, value: value || null };
}

export function bandCell(band: DoraBand | null): string {
  switch (band) {
    case "elite":
      return c.green("elite");
    case "high":
      return c.cyan("high");
    case "medium":
      return c.yellow("medium");
    case "low":
      return c.red("low");
    case null:
      return c.dim("-");
  }
}

function arrow(core: Core, metric: DoraMetric, cur: number | null, prev: number | null): string {
  const dir = core.doraTrendDirection(metric, cur, prev);
  if (dir === "better") return c.green("▲ better");
  if (dir === "worse") return c.red("▼ worse");
  if (dir === "flat") return c.dim("= same");
  return "";
}

function metricRows(core: Core, report: DoraReport) {
  const s = report.summary;
  const p = report.previous;
  const trend = (pick: (b: DoraReport["trend"][number]) => number | null) => {
    const values = report.trend.map((b) => pick(b) ?? 0);
    return values.length > 1 ? sparkline(values, Math.min(values.length, 40)) : "";
  };
  return [
    {
      name: "deployment frequency",
      value:
        s.deploymentFrequency.deploys > 0
          ? core.formatDeployFrequency(s.deploymentFrequency.value)
          : "none",
      detail: `${s.deploymentFrequency.deploys} deploys`,
      band: s.deploymentFrequency.band,
      prev: core.formatDeployFrequency(p.deploymentFrequency.value),
      delta: arrow(
        core,
        "deployment_frequency",
        s.deploymentFrequency.value,
        p.deploymentFrequency.value,
      ),
      spark: trend((b) => b.deploys),
    },
    {
      name: "lead time",
      value: core.formatDoraHours(s.leadTime.value),
      detail:
        s.leadTime.sample > 0
          ? `median of ${s.leadTime.sample}, p90 ${core.formatDoraHours(s.leadTime.p90Hours)}`
          : "no commit times",
      band: s.leadTime.band,
      prev: core.formatDoraHours(p.leadTime.value),
      delta: arrow(core, "lead_time", s.leadTime.value, p.leadTime.value),
      spark: trend((b) => b.leadTimeMedianHours),
    },
    {
      name: "change failure rate",
      value: core.formatDoraRate(s.changeFailureRate.value),
      detail: `${s.changeFailureRate.failures} of ${s.changeFailureRate.changes} changes`,
      band: s.changeFailureRate.band,
      prev: core.formatDoraRate(p.changeFailureRate.value),
      delta: arrow(
        core,
        "change_failure_rate",
        s.changeFailureRate.value,
        p.changeFailureRate.value,
      ),
      spark: trend((b) => b.changeFailureRate),
    },
    {
      name: "time to restore",
      value: core.formatDoraHours(s.timeToRestore.value),
      detail: `${s.timeToRestore.restores} recoveries`,
      band: s.timeToRestore.band,
      prev: core.formatDoraHours(p.timeToRestore.value),
      delta: arrow(core, "time_to_restore", s.timeToRestore.value, p.timeToRestore.value),
      spark: trend((b) => b.restoreMedianHours),
    },
  ];
}

function scopeLabel(report: DoraReport): string {
  if (!report.filter) return "all production";
  const dim =
    report.dimensions.find((d) => d.id === report.filter!.dimension)?.label ??
    report.filter.dimension;
  if (report.filter.value === null) return `${dim.toLowerCase()} not known`;
  const v = report.scopeValues[report.filter.dimension]?.find(
    (x) => x.key === report.filter!.value,
  );
  return `${dim.toLowerCase()} ${v?.label ?? report.filter.value}`;
}

function failureCell(change: DoraChange): string {
  const f = change.failure;
  if (!f) return "";
  switch (f.kind) {
    case "incident":
      return c.red(`incident: ${safe(f.title)}`);
    case "rollback":
      return c.red("rolled back");
    case "failed_deploy":
      return c.red("deploy failed");
    case "reverted":
      return c.red("reverted");
  }
}

export async function cmdDora(
  ctx: CliContext,
  sub: string | undefined,
  range: RangeFlags,
  flags: DoraFlags,
): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Delivery metrics live in Infrawrench Cloud, beside the deploys and incidents. Drop --local.",
    );
  }
  const core: Core = await import("@infrawrench/client-core");
  const org = await resolveOrg(ctx);
  const window = doraWindow(range);
  const query: DoraQuery = { ...window, ...parseDoraScope(flags.scope) };

  if (sub === "settings") {
    const settings = await orgFetch<DoraSettingsView>(org.id, "/dora/settings");
    if (ctx.flags.output === "json") return printJson({ org: org.id, settings });
    println(c.bold("Delivery settings"));
    println(`production environments  ${safe(settings.productionEnvironments.join(", "))}`);
    println(
      `deploy pipelines         ${settings.pipelinePatterns.length > 0 ? safe(settings.pipelinePatterns.join(", ")) : c.dim("none")}`,
    );
    println(`failure window           ${settings.failureWindowHours}h`);
    println(`failed deploys count     ${settings.countFailedDeploys ? "yes" : "no"}`);
    println(`resource changes count   ${settings.includeResourceChanges ? "yes" : "no"}`);
    println(`weekly digest line       ${settings.digestEnabled ? "on" : "off"}`);
    println();
    println(
      c.dim(
        "Edit them on the Delivery tab (Settings), or with the infrawrench_dora_settings Terraform resource.",
      ),
    );
    return;
  }

  if (sub === "changes") {
    const res = await orgFetch<DoraChangesResponse>(
      org.id,
      `/dora/changes?${core.doraQueryString({ ...query, failedOnly: flags.failed })}`,
    );
    if (ctx.flags.output === "json") return printJson({ org: org.id, ...window, ...res });
    if (res.changes.length === 0) {
      println(
        c.dim(
          flags.failed
            ? "No failed production changes in the range."
            : "No production changes in the range.",
        ),
      );
      return;
    }
    const columns: Column<DoraChange>[] = [
      { header: "when", value: (x) => c.dim(formatChangeTime(x.at)) },
      {
        header: "change",
        value: (x) => `${safe(x.name)}${x.isRollback ? c.yellow(" (rollback)") : ""}`,
      },
      { header: "env", value: (x) => safe(x.environment ?? "-") },
      { header: "commit", value: (x) => c.dim(x.commitSha ? x.commitSha.slice(0, 7) : "-") },
      { header: "lead time", value: (x) => core.formatDoraHours(x.leadTimeHours), align: "right" },
      { header: "source", value: (x) => c.dim(x.pluginId ?? x.source) },
      { header: "failure", value: failureCell },
    ];
    printTable(res.changes, columns);
    if (res.truncated)
      println(
        c.dim(`Showing the newest ${res.changes.length}. Narrow --last or --scope for the rest.`),
      );
    return;
  }

  if (sub === "restores") {
    const res = await orgFetch<DoraRestoresResponse>(
      org.id,
      `/dora/restores?${core.doraQueryString(query)}`,
    );
    if (ctx.flags.output === "json") return printJson({ org: org.id, ...window, ...res });
    if (res.restores.length === 0) {
      println(c.dim("No incidents resolved or deploys rolled back in the range."));
      return;
    }
    printTable(res.restores, [
      { header: "restored", value: (r) => c.dim(formatChangeTime(r.restoredAt)) },
      { header: "kind", value: (r) => (r.kind === "incident" ? "incident" : c.yellow("rollback")) },
      { header: "what", value: (r) => safe(r.title) },
      { header: "took", value: (r) => core.formatDoraHours(r.hours), align: "right" },
    ]);
    return;
  }

  if (sub !== undefined) {
    throw new CliError(
      `Unknown "dora ${sub}". Use: dora, dora changes [--failed], dora restores, dora settings.`,
      2,
    );
  }

  const report = await orgFetch<DoraReport>(
    org.id,
    `/dora?${core.doraQueryString({ ...query, ...(range.groupBy ? { groupBy: range.groupBy } : {}) })}`,
  );
  if (ctx.flags.output === "json") return printJson({ org: org.id, ...report });

  const days = Math.round((Date.parse(report.to) - Date.parse(report.from)) / DAY_MS);
  println(
    `${c.bold(safe(org.displayName))} ${c.dim(`· delivery · last ${days} days · ${safe(scopeLabel(report))}`)}`,
  );
  println();
  if (report.eventCount === 0 && report.summary.changeFailureRate.changes === 0) {
    println(
      c.dim(
        "No deploys in the range. Metrics come from Infrawrench deploys, synced provider deploys,",
      ),
    );
    println(
      c.dim("CI pipelines named in the settings, GitHub deployments and POST /dora/deployments."),
    );
    return;
  }
  printTable(metricRows(core, report), [
    { header: "metric", value: (r) => r.name },
    { header: "value", value: (r) => c.bold(r.value), align: "right" },
    { header: "band", value: (r) => bandCell(r.band) },
    { header: "previous", value: (r) => c.dim(r.prev), align: "right" },
    { header: "", value: (r) => r.delta },
    { header: `trend (per ${report.bucket})`, value: (r) => c.cyan(r.spark) },
    { header: "", value: (r) => c.dim(r.detail) },
  ]);

  if (report.breakdown.length > 0) {
    const dim = report.dimensions.find((d) => d.id === report.groupBy)?.label ?? report.groupBy;
    println();
    println(c.bold(`by ${dim.toLowerCase()}`));
    printTable(report.breakdown, [
      {
        header: dim.toLowerCase(),
        value: (r) => (r.key === null ? c.dim("not known") : safe(r.label)),
      },
      {
        header: "deploys",
        value: (r) => String(r.summary.deploymentFrequency.deploys),
        align: "right",
      },
      {
        header: "frequency",
        value: (r) => core.formatDeployFrequency(r.summary.deploymentFrequency.value),
        align: "right",
      },
      {
        header: "lead time",
        value: (r) => core.formatDoraHours(r.summary.leadTime.value),
        align: "right",
      },
      {
        header: "failure",
        value: (r) => core.formatDoraRate(r.summary.changeFailureRate.value),
        align: "right",
      },
      {
        header: "restore",
        value: (r) => core.formatDoraHours(r.summary.timeToRestore.value),
        align: "right",
      },
      { header: "", value: (r) => bandSummary(r.summary) },
    ]);
  }
  println();
  println(c.dim("`dora changes [--failed]` and `dora restores` list what is behind the numbers."));
  println(
    c.dim(
      `Scope with --scope <${report.dimensions.map((d) => d.id).join("|")}>=<value>; group with --group-by.`,
    ),
  );
}

function bandSummary(s: DoraSummary): string {
  return [
    s.deploymentFrequency.band,
    s.leadTime.band,
    s.changeFailureRate.band,
    s.timeToRestore.band,
  ]
    .map((b) => bandCell(b))
    .join(c.dim(" "));
}
