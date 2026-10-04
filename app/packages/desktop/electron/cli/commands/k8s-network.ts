// `infrawrench k8s-network [cluster]`: one Kubernetes cluster's network
// costs by traffic class, namespace and workload, plus its top talkers.
//
// Cloud-only: pod traffic is collected server-side into the network-flow
// store, and the billed data transfer it is apportioned against lives in the
// cloud cost store.
//
// The text output keeps the surface's honesty rules: the list estimate and the
// billed allocation are printed as two different numbers, the unallocated
// remainder sits beside them, and how much of the traffic came from pod
// counters alone (no destination, no boundary) is said out loud.
//
// The response shapes come from `@infrawrench/client-core`; the import is
// type-only, so the CLI still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveAccount, resolveOrg, type CliContext } from "../context";
import type {
  KubernetesNetworkReport,
  KubernetesNetworkRow,
  NetworkFlowFeed,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags } from "../args";
import { resolveDateRange } from "../args";
import { c, formatMoney, printJson, println, printTable, type Column } from "../output";
import { barChart } from "../charts";

// Duplicated from client-core rather than imported: the CLI takes type-only
// imports from workspace packages so it ships no runtime dependency on them.
const SCOPE_LABELS: Record<string, string> = {
  intra_zone: "same zone",
  cross_zone: "cross-zone",
  cross_region: "cross-region",
  internet_egress: "internet egress",
  internet_ingress: "internet ingress",
  provider_service: "provider service",
  nat_gateway: "NAT gateway",
  private_interconnect: "VPN / interconnect",
  unknown: "unclassified",
};

const METHOD_LABELS: Record<string, string> = {
  flow_log: "cloud flow logs",
  in_cluster_flows: "in-cluster flows",
  counter_estimate: "pod counters only",
  "": "mixed",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function rowMoney(report: KubernetesNetworkReport, row: KubernetesNetworkRow): string {
  return formatMoney(row.allocatedCost ?? row.estimatedCost, report.currency);
}

function topScope(row: KubernetesNetworkRow): string {
  const entries = Object.entries(row.byScope).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return entries[0] ? (SCOPE_LABELS[entries[0][0]] ?? entries[0][0]) : "";
}

export async function cmdK8sNetwork(
  ctx: CliContext,
  wanted: string,
  range: RangeFlags,
): Promise<void> {
  const org = await resolveOrg(ctx);
  const feed = await orgFetch<NetworkFlowFeed>(org.id, "/network-flows?limit=1");
  const clusters = feed.accounts.filter((a) => a.supportsFlows && a.recut);
  if (clusters.length === 0) {
    throw new CliError(
      "No Kubernetes account reports pod network traffic in this organization. Add a Kubernetes account and turn on network flow collection.",
    );
  }
  let accountId: string;
  if (wanted) {
    accountId = resolveAccount(
      clusters.map((a) => ({ id: a.accountId, pluginId: a.pluginId, displayName: a.displayName })),
      wanted,
    ).id;
  } else if (clusters.length === 1) {
    accountId = clusters[0]!.accountId;
  } else {
    throw new CliError(
      `Several clusters report network traffic; name one: ${clusters.map((a) => a.displayName).join(", ")}.`,
    );
  }

  const { from, to } = resolveDateRange({ ...range, last: range.last ?? "14d" });
  const params = new URLSearchParams({ from, to });
  if (range.limit) params.set("limit", String(range.limit));
  const report = await orgFetch<KubernetesNetworkReport>(
    org.id,
    `/network-flows/kubernetes/${encodeURIComponent(accountId)}?${params.toString()}`,
  );

  if (ctx.flags.output === "json") {
    printJson(report);
    return;
  }

  println(
    `${c.bold(`~${formatMoney(report.totals.estimatedCost, report.currency)}`)} ${c.dim(
      `· estimated at list price · ${report.displayName} · ${report.range.from} → ${report.range.to} · ${formatBytes(report.totals.bytes)}`,
    )}`,
  );
  if (report.billed.billedCost !== null) {
    println(
      `${formatMoney(report.billed.billedCost, report.currency)} billed · ${c.bold(
        formatMoney(report.totals.allocatedCost ?? 0, report.currency),
      )} allocated to workloads · ${c.yellow(
        `${formatMoney(report.totals.unallocatedCost ?? 0, report.currency)} unallocated`,
      )}${report.billed.basis === "bytes" ? c.yellow(" · split by bytes alone (weakest basis)") : ""}`,
    );
  } else {
    println(c.dim("No billed data-transfer source set: figures are list-price estimates."));
  }
  if (report.billed.error) println(c.red(report.billed.error));
  if (report.totals.bytes > 0 && report.methods.length > 0) {
    println(
      c.dim(
        report.methods
          .map(
            (m) =>
              `${METHOD_LABELS[m.method] ?? m.method} ${Math.round((m.bytes / report.totals.bytes) * 100)}%`,
          )
          .join(" · "),
      ),
    );
  }

  for (const source of report.collection?.sources ?? []) {
    if (!source.usable && source.unusableReason) println(c.dim(`· ${source.unusableReason}`));
  }
  if (report.collection?.lastError) println(c.red(report.collection.lastError));

  if (report.scopes.length > 0) {
    println();
    println(c.bold("By traffic class"));
    for (const line of barChart(
      report.scopes.map((s) => ({
        label: SCOPE_LABELS[s.scope] ?? s.scope,
        value: s.allocatedCost ?? s.estimatedCost,
        display: `${formatMoney(s.allocatedCost ?? s.estimatedCost, report.currency)} ${c.dim(formatBytes(s.bytes))}`,
      })),
    )) {
      println(line);
    }
  }

  const columns: Column<KubernetesNetworkRow>[] = [
    { header: "name", value: (r) => r.label },
    { header: "mostly", value: (r) => c.dim(topScope(r)) },
    { header: "source", value: (r) => c.dim(METHOD_LABELS[r.method] ?? r.method) },
    { header: "bytes", value: (r) => formatBytes(r.bytes), align: "right" },
    {
      header: report.billed.billedCost !== null ? "allocated" : "estimated",
      value: (r) => rowMoney(report, r),
      align: "right",
    },
  ];
  if (report.namespaces.length > 0) {
    println();
    println(c.bold("By namespace"));
    printTable(report.namespaces.slice(0, 15), columns);
  }
  if (report.workloads.length > 0) {
    println();
    println(c.bold("By workload"));
    printTable(report.workloads.slice(0, 20), columns);
  }
  if (report.topTalkers.length > 0) {
    println();
    println(c.bold("Top talkers"));
    for (const pair of report.topTalkers.slice(0, 15)) {
      println(
        `  ${pair.source.label || pair.source.ref} → ${pair.destination.label || pair.destination.ref} ${c.dim(
          `${SCOPE_LABELS[pair.scope] ?? pair.scope} · ${formatBytes(pair.bytes)}`,
        )} ${formatMoney(pair.estimatedCost, pair.currency)}`,
      );
    }
  }
  println();
  println(
    c.dim(
      "Derived, never collected: these bytes also leave through the nodes, so they are kept out of org-wide network totals and never added to the cost store.",
    ),
  );
}
