// `infrawrench k8s-efficiency [name|id]`: Kubernetes efficiency reports.
//
// Bare, it lists the saved reports. With a name or id it runs one and prints
// the totals (used, requested-but-unused, unmeasured, idle, overhead and the
// efficiency percentage), the per-category split and a row per group.
// `--group-by` without a name runs an unsaved report over every visible
// cluster instead (`cluster`, `namespace`, `workload`, `node_pool`,
// `category`, or any label key such as `k8s_pod_label:team`).
// `--format csv|ndjson` writes the report's export, per period, to stdout or
// `--out <path>`.
//
// Cloud-only: the report reads the cost rows the cloud poller collects. The
// response shapes come from `@infrawrench/client-core` as type-only imports,
// so the CLI ships no new runtime dependency.
import { writeFileSync } from "node:fs";
import { CliError, orgFetch, orgFetchText, resolveOrg, type CliContext } from "../context";
import type {
  KubernetesEfficiencyConfig,
  KubernetesEfficiencyCurrencyResult,
  KubernetesEfficiencyFigures,
  KubernetesEfficiencyReport,
  KubernetesEfficiencyResult,
  KubernetesEfficiencyRunResult,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { ExportFlags, RangeFlags } from "../args";
import { resolveDateRange } from "../args";
import { matchCostReport } from "../format";
import { c, formatMoney, printJson, println, printTable } from "../output";
import { barChart } from "../charts";

// Restated rather than imported: the CLI takes type-only imports from
// workspace packages.
const CATEGORY_LABELS: Record<string, string> = {
  cpu: "CPU",
  memory: "Memory",
  gpu: "GPU",
  storage: "Storage",
  network: "Network",
  control_plane: "Control plane",
  compute: "CPU and memory (combined)",
};
const ROW_KIND_LABELS: Record<string, string> = {
  idle: "Idle capacity",
  overhead: "Cluster overhead",
  unattributed: "(no value)",
};
const FIXED_GROUP_BYS = ["cluster", "namespace", "workload", "node_pool", "category"] as const;

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Kubernetes efficiency reports live in Infrawrench Cloud: they read the cost the cloud collects from each cluster.",
    );
  }
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

/** `--group-by` to a config's grouping: a fixed one, or any label key. */
export function parseEfficiencyGroupBy(
  raw: string,
): Pick<KubernetesEfficiencyConfig, "groupBy" | "groupByLabelKey"> {
  const value = raw.trim();
  if (!value) throw new CliError("--group-by needs a value.");
  if ((FIXED_GROUP_BYS as readonly string[]).includes(value)) {
    return { groupBy: value as KubernetesEfficiencyConfig["groupBy"] };
  }
  // `tag:team`, `label:team` and a bare key all group by that tag key;
  // `k8s_pod_label:team` and friends are already tag keys.
  const key = value.replace(/^(tag|label):/, "");
  return { groupBy: "label", groupByLabelKey: key };
}

export async function cmdK8sEfficiency(
  ctx: CliContext,
  query: string,
  range: RangeFlags,
  exportFlags: ExportFlags,
): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const format = exportFlags.format;
  if (format && format !== "csv" && format !== "ndjson") {
    throw new CliError("--format must be csv or ndjson.");
  }

  if (!query && !range.groupBy) {
    if (format) {
      throw new CliError("Which report? `infrawrench k8s-efficiency <name|id> --format csv`.");
    }
    const reports = await orgFetch<KubernetesEfficiencyReport[]>(org.id, "/k8s-efficiency-reports");
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, reports });
      return;
    }
    println(`${c.bold(org.displayName)} ${c.dim("· Kubernetes efficiency reports")}`);
    println();
    if (reports.length === 0) {
      println(
        c.dim(
          "No saved reports. Create one on the Kubernetes efficiency page, or run one ad hoc: `infrawrench k8s-efficiency --group-by namespace`.",
        ),
      );
      return;
    }
    printTable(reports, [
      { header: "name", value: (r) => c.bold(r.name) },
      {
        header: "grouped by",
        value: (r) =>
          r.config.groupBy === "label" ? (r.config.groupByLabelKey ?? "label") : r.config.groupBy,
      },
      { header: "basis", value: (r) => r.config.basis },
      { header: "idle", value: (r) => r.config.idle },
      { header: "id", value: (r) => c.dim(r.id) },
    ]);
    return;
  }

  let name: string;
  let result: KubernetesEfficiencyResult;
  if (query) {
    const reports = await orgFetch<KubernetesEfficiencyReport[]>(org.id, "/k8s-efficiency-reports");
    const found = matchCostReport(reports, query);
    if (!found.match) {
      throw new CliError(
        found.candidates.length === 0
          ? `No Kubernetes efficiency report matches "${query}". Run \`infrawrench k8s-efficiency\` to list them.`
          : `"${query}" matches ${found.candidates.length} reports: ${found.candidates
              .map((r) => r.name)
              .join(", ")}. Use the full name or the id.`,
      );
    }
    const report = found.match;
    if (format) {
      const body = await orgFetchText(
        org.id,
        `/k8s-efficiency-reports/${encodeURIComponent(report.id)}/export?format=${format}&perPeriod=true`,
      );
      if (exportFlags.out) {
        writeFileSync(exportFlags.out, body);
        println(c.dim(`Wrote ${exportFlags.out}`));
      } else {
        process.stdout.write(body);
      }
      return;
    }
    const run = await orgFetch<KubernetesEfficiencyRunResult>(
      org.id,
      `/k8s-efficiency-reports/${encodeURIComponent(report.id)}/run`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    name = run.name;
    result = run.result;
  } else {
    if (format) {
      throw new CliError("--format exports a saved report: name one.");
    }
    if (range.basis && range.basis !== "total" && range.basis !== "allocated") {
      throw new CliError("--basis must be total or allocated for k8s-efficiency.");
    }
    const { from, to } = resolveDateRange(range);
    const config: KubernetesEfficiencyConfig = {
      version: 1,
      dateRange: { kind: "absolute", from, to },
      granularity: "day",
      filters: [],
      ...parseEfficiencyGroupBy(range.groupBy ?? ""),
      idle: "separate",
      basis: (range.basis === "allocated"
        ? "allocated"
        : "total") as KubernetesEfficiencyConfig["basis"],
    };
    name = "Kubernetes efficiency";
    result = await orgFetch<KubernetesEfficiencyResult>(org.id, "/k8s-efficiency-reports/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, name, ...result });
    return;
  }
  printResult(name, result);
}

function printResult(name: string, result: KubernetesEfficiencyResult): void {
  println(
    `${c.bold(name)} ${c.dim(
      `· ${result.from} → ${result.to} · by ${
        result.groupBy === "label" ? (result.groupByLabelKey ?? "label") : result.groupBy
      } · efficiency of ${result.basis === "allocated" ? "allocated" : "total"} cost · idle ${result.idle}`,
    )}`,
  );
  if (result.includesLegacyRows) {
    println(
      c.dim(
        "Part of this window predates the CPU/memory and usage split: that cost is shown as combined and unmeasured.",
      ),
    );
  }
  if (result.currencies.length === 0) {
    println();
    println(
      c.dim(
        "No Kubernetes cost in this window. A cluster reports cost once its node prices are known (from its cloud account, or the Kubernetes account's node rates field).",
      ),
    );
    return;
  }
  for (const block of result.currencies) printBlock(block);
}

function printBlock(block: KubernetesEfficiencyCurrencyResult): void {
  const money = (n: number) => formatMoney(n, block.currency);
  const t = block.totals;
  println();
  println(
    `${c.bold(money(t.total))} ${c.dim("total")} · ${c.bold(pct(t.efficiency))} ${c.dim("efficient")}${
      t.measuredShare !== null && t.measuredShare < 0.999
        ? c.yellow(` · ${pct(t.measuredShare)} measured`)
        : ""
    }`,
  );
  println(
    c.dim(
      `used ${money(t.used)} · requested, unused ${money(t.unused)} · unmeasured ${money(t.unmeasured)} · idle ${money(t.idle)} · overhead ${money(t.overhead)}`,
    ),
  );

  if (block.categories.length > 0) {
    println();
    println(c.bold("By cost category"));
    for (const line of barChart(
      block.categories.map(({ category, figures }) => ({
        label: CATEGORY_LABELS[category] ?? category,
        value: figures.total,
        display: `${money(figures.total)} ${c.dim(pct(figures.efficiency))}`,
      })),
    )) {
      println(line);
    }
  }

  println();
  const cell =
    (pick: (f: KubernetesEfficiencyFigures) => number) => (f: KubernetesEfficiencyFigures) =>
      money(pick(f));
  printTable(block.rows, [
    {
      header: "group",
      value: (r) => (r.kind === "group" ? r.label : c.dim(ROW_KIND_LABELS[r.kind] ?? r.kind)),
    },
    { header: "total", value: (r) => cell((f) => f.total)(r.figures), align: "right" },
    { header: "used", value: (r) => cell((f) => f.used)(r.figures), align: "right" },
    { header: "unused", value: (r) => cell((f) => f.unused)(r.figures), align: "right" },
    { header: "unmeasured", value: (r) => cell((f) => f.unmeasured)(r.figures), align: "right" },
    { header: "idle", value: (r) => cell((f) => f.idle)(r.figures), align: "right" },
    { header: "overhead", value: (r) => cell((f) => f.overhead)(r.figures), align: "right" },
    { header: "efficiency", value: (r) => pct(r.figures.efficiency), align: "right" },
  ]);
}
