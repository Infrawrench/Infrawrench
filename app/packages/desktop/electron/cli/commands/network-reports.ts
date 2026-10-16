// `infrawrench network-reports [name|id]`: saved network flow reports. Lists
// them, or runs one: bytes and estimated cost over time by the report's
// grouping, the group totals and the top talking pairs. Text output is
// hand-rolled (tables and a sparkline); `--json` prints the server's result
// as is; `--format csv` writes the series CSV and `--format pairs-csv` the
// top-talkers CSV, the same files the web and desktop export buttons save.
//
// Cloud-only: flows are collected server-side into the network-flow store.
import { writeFileSync } from "node:fs";

import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  NetworkFlowReport,
  NetworkFlowReportNotice,
  NetworkFlowReportResult,
  NetworkFlowReportRunResult,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { sparkline } from "../charts";
import { matchCostReport } from "../format";
import { c, formatMoney, printJson, println, printTable, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

export interface NetworkReportCliFlags {
  format?: string | undefined;
  out?: string | undefined;
}

const NOTICE_TEXT: Record<NetworkFlowReportNotice, string> = {
  collection_disabled: "Flow collection is off for this organization: nothing new is recorded.",
  no_flow_accounts: "No account you can see has a provider that reports network flows.",
  beyond_retention: "The window starts more than 90 days ago; flows are kept for 90 days.",
  sampled_sources:
    "Some figures come from a flow source that samples traffic (the provider's scaled-up estimate).",
  recut_excluded:
    "Kubernetes cluster traffic is left out (a cloud flow log already counts it); filter to a cluster's account to include it.",
  unattributed_traffic: "Some bytes could not be tied to a workload at one end.",
  truncated_traffic: "Some days had more pairs than are stored; the rest is counted, not listed.",
  multiple_currencies: "Rate cards in more than one currency: totals are per currency.",
};

const UNATTRIBUTED_REF = "infrawrench:unattributed";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Network flow reports live in Infrawrench Cloud: flows are collected server-side.",
    );
  }
}

function endpointName(core: Core, ref: string, label: string): string {
  if (ref === core.NETWORK_FLOW_REPORT_TRUNCATED_KEY) return "flows outside the stored top pairs";
  if (ref === UNATTRIBUTED_REF) return "unidentified peer";
  return label || ref;
}

function groupName(core: Core, result: NetworkFlowReportResult, key: string, label: string) {
  if (key === core.NETWORK_FLOW_REPORT_OTHER_KEY) return "everything else";
  if (result.groupBy === "traffic_class") {
    return (
      core.NETWORK_FLOW_SCOPE_LABELS[key as keyof typeof core.NETWORK_FLOW_SCOPE_LABELS] ?? key
    );
  }
  if (result.groupBy === "source" || result.groupBy === "destination") {
    return endpointName(core, key, label);
  }
  if (key === "" && result.groupBy !== "none") return c.dim("(not set)");
  return label || key;
}

function writeCsv(csv: string, out: string | undefined) {
  if (out) {
    writeFileSync(out, csv, "utf8");
    println(c.dim(`Wrote ${out}`));
    return;
  }
  process.stdout.write(csv);
}

function printResult(core: Core, result: NetworkFlowReportRunResult) {
  const showCost = result.metric !== "bytes";
  const showBytes = result.metric !== "cost";
  println(
    `${c.bold(result.name)} ${c.dim(
      `· ${result.from} to ${result.to} · ${core.NETWORK_FLOW_REPORT_GRANULARITY_LABELS[result.granularity].toLowerCase()}` +
        (result.groupBy !== "none"
          ? ` · by ${core.NETWORK_FLOW_REPORT_GROUP_BY_LABELS[result.groupBy].toLowerCase()}`
          : ""),
    )}`,
  );
  println(c.dim("  Estimated from flow logs at list prices: it will not match the invoice."));
  for (const n of result.notices) println(c.yellow(`  ${NOTICE_TEXT[n]}`));
  println();

  for (const s of result.overall) {
    const sampled = core.networkFlowSampledShare(s.total);
    const parts = [
      showCost ? `${c.bold(formatMoney(s.total.estimatedCost, s.currency))} estimated` : "",
      showBytes ? `${c.bold(core.formatFlowBytes(s.total.bytes))}` : "",
      sampled > 0 ? c.yellow(`${Math.round(sampled * 100)}% sampled`) : "",
      `${Math.round(core.attributionCoverage(s.total) * 100)}% attributed to a pair`,
    ].filter(Boolean);
    println(`${c.bold(s.currency)}  ${parts.join("  ·  ")}`);
    const values = s.points.map((p) => (showCost ? p.estimatedCost : p.bytes));
    if (values.length > 1) {
      println(
        `     ${showCost ? "cost" : "bytes"}  ${sparkline(values, Math.min(48, values.length))}`,
      );
    }
  }
  println();

  if (result.groupBy !== "none" && result.groups.length > 0) {
    type Row = (typeof result.groups)[number];
    const columns: Column<Row>[] = [
      {
        header: core.NETWORK_FLOW_REPORT_GROUP_BY_LABELS[result.groupBy].toLowerCase(),
        value: (g) => groupName(core, result, g.groupKey, g.label),
      },
      ...(showBytes
        ? [
            {
              header: "bytes",
              value: (g: Row) => core.formatFlowBytes(g.bytes),
              align: "right" as const,
            },
          ]
        : []),
      ...(showCost
        ? [
            {
              header: "est. cost",
              value: (g: Row) => formatMoney(g.estimatedCost, g.currency),
              align: "right" as const,
            },
          ]
        : []),
      { header: "pairs", value: (g) => String(g.pairCount), align: "right" },
      {
        header: "sampled",
        value: (g) => {
          const share = core.networkFlowSampledShare(g);
          return share > 0 ? `${Math.round(share * 100)}%` : "";
        },
        align: "right",
      },
    ];
    printTable(result.groups, columns);
    if (result.groupCount > result.groups.length) {
      println(c.dim(`  ${result.groupCount - result.groups.length} more not listed.`));
    }
    println();
  }

  if (result.topTalkers.length === 0) {
    println(c.dim("No flow pairs in this window for these filters."));
    return;
  }
  type Talker = (typeof result.topTalkers)[number];
  const columns: Column<Talker>[] = [
    { header: "source", value: (t) => endpointName(core, t.source.ref, t.source.label) },
    {
      header: "destination",
      value: (t) => endpointName(core, t.destination.ref, t.destination.label),
    },
    {
      header: "class",
      value: (t) =>
        `${core.NETWORK_FLOW_SCOPE_LABELS[t.scope] ?? t.scope}${t.direction === "ingress" ? " (in)" : ""}`,
    },
    ...(showBytes
      ? [
          {
            header: "bytes",
            value: (t: Talker) => core.formatFlowBytes(t.bytes),
            align: "right" as const,
          },
        ]
      : []),
    ...(showCost
      ? [
          {
            header: "est. cost",
            value: (t: Talker) =>
              `${formatMoney(t.estimatedCost, t.currency)}${t.sampled ? c.yellow("*") : ""}`,
            align: "right" as const,
          },
        ]
      : []),
    { header: "days", value: (t) => String(t.days), align: "right" },
  ];
  printTable(result.topTalkers, columns);
  if (result.topTalkers.some((t) => t.sampled)) {
    println(c.dim("* from a sampled flow source"));
  }
}

/** `network-reports`: list, or run one by name or id. */
export async function cmdNetworkReports(
  ctx: CliContext,
  query: string,
  flags: NetworkReportCliFlags,
): Promise<void> {
  requireCloud(ctx);
  const core: Core = await import("@infrawrench/client-core");
  const org = await resolveOrg(ctx);
  const reports = await orgFetch<NetworkFlowReport[]>(org.id, "/network-flows/reports");

  if (!query) {
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, reports });
      return;
    }
    if (reports.length === 0) {
      println(
        c.dim(
          "No network flow reports. Create one on the Costs page under Network, or with the infrawrench_network_flow_report Terraform resource.",
        ),
      );
      return;
    }
    const columns: Column<NetworkFlowReport>[] = [
      { header: "report", value: (r) => r.name },
      { header: "shows", value: (r) => core.NETWORK_FLOW_REPORT_METRIC_LABELS[r.config.metric] },
      {
        header: "granularity",
        value: (r) => core.NETWORK_FLOW_REPORT_GRANULARITY_LABELS[r.config.granularity],
      },
      {
        header: "group by",
        value: (r) => core.NETWORK_FLOW_REPORT_GROUP_BY_LABELS[r.config.groupBy],
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
        ? `"${query}" matches ${found.candidates.length} network flow reports: ${found.candidates.map((r) => r.name).join(", ")}. Use the id.`
        : `No network flow report named "${query}".`,
    );
  }
  const report = found.match;
  const result = await orgFetch<NetworkFlowReportRunResult>(
    org.id,
    `/network-flows/reports/${encodeURIComponent(report.id)}/run`,
    { method: "POST", body: "{}" },
  );
  if (flags.format === "csv") {
    writeCsv(core.networkFlowReportToCsv(result), flags.out);
    return;
  }
  if (flags.format === "pairs-csv") {
    writeCsv(core.networkFlowReportPairsToCsv(result), flags.out);
    return;
  }
  if (flags.format) {
    throw new CliError("--format takes csv or pairs-csv for network flow reports.", 2);
  }
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...result });
    return;
  }
  printResult(core, result);
}
