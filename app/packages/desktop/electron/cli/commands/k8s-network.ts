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
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { KubernetesNetworkReport, NetworkFlowFeed } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { findAccount } from "../context";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { dateRange, limit, resolveDateRange } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, formatMoney, safe, type Column } from "../output";
import { barChart } from "../charts";

// Duplicated from client-core rather than imported: the CLI takes type-only
// imports from workspace packages so it ships no runtime dependency on them.
const SCOPE_LABELS: Partial<Record<string, string>> = {
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

const METHOD_LABELS: Partial<Record<string, string>> = {
  flow_log: "cloud flow logs",
  in_cluster_flows: "in-cluster flows",
  counter_estimate: "pod counters only",
  "": "mixed",
};

const scopeLabel = (scope: string) => SCOPE_LABELS[scope] ?? safe(scope);
const methodLabel = (method: string) => METHOD_LABELS[method] ?? safe(method);

const Feed = wire<NetworkFlowFeed>()(
  Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        accountId: Schema.String,
        pluginId: Schema.String,
        displayName: Schema.String,
        supportsFlows: Schema.Boolean,
        recut: Schema.Boolean,
      }),
    ),
  }),
);

const Row = Schema.Struct({
  label: Schema.String,
  bytes: Schema.Finite,
  estimatedCost: Schema.Finite,
  allocatedCost: Schema.NullOr(Schema.Finite),
  byScope: Schema.Record(Schema.String, Schema.Finite),
  method: Schema.String,
});
type Row = typeof Row.Type;

const Endpoint = Schema.Struct({ ref: Schema.String, label: Schema.String });

// The scope, method and basis enums all render through a fallback, so they
// stay strings.
const Report = wire<KubernetesNetworkReport>()(
  Schema.Struct({
    displayName: Schema.String,
    range: Schema.Struct({ from: Schema.String, to: Schema.String }),
    currency: Schema.String,
    totals: Schema.Struct({
      bytes: Schema.Finite,
      estimatedCost: Schema.Finite,
      allocatedCost: Schema.NullOr(Schema.Finite),
      unallocatedCost: Schema.NullOr(Schema.Finite),
    }),
    billed: Schema.Struct({
      error: Schema.NullOr(Schema.String),
      billedCost: Schema.NullOr(Schema.Finite),
      basis: Schema.String,
    }),
    scopes: Schema.Array(
      Schema.Struct({
        scope: Schema.String,
        bytes: Schema.Finite,
        estimatedCost: Schema.Finite,
        allocatedCost: Schema.NullOr(Schema.Finite),
      }),
    ),
    methods: Schema.Array(Schema.Struct({ method: Schema.String, bytes: Schema.Finite })),
    namespaces: Schema.Array(Row),
    workloads: Schema.Array(Row),
    topTalkers: Schema.Array(
      Schema.Struct({
        source: Endpoint,
        destination: Endpoint,
        scope: Schema.String,
        bytes: Schema.Finite,
        estimatedCost: Schema.Finite,
        currency: Schema.String,
      }),
    ),
    collection: Schema.NullOr(
      Schema.Struct({
        lastError: Schema.NullOr(Schema.String),
        sources: Schema.Array(
          Schema.Struct({ usable: Schema.Boolean, unusableReason: Schema.NullOr(Schema.String) }),
        ),
      }),
    ),
  }),
);
type Report = typeof Report.Type;

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

function rowMoney(report: Report, row: Row): string {
  return formatMoney(row.allocatedCost ?? row.estimatedCost, report.currency);
}

function topScope(row: Row): string {
  const entries = Object.entries(row.byScope).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return entries[0] ? scopeLabel(entries[0][0]) : "";
}

export const k8sNetwork = Command.make(
  "k8s-network",
  {
    cluster: Argument.String("cluster").pipe(
      Argument.withDescription("The cluster's account (needed when several report traffic)"),
      Argument.variadic(),
    ),
    ...dateRange,
    limit: limit.pipe(Flag.withDescription("Rows per table")),
  },
  Effect.fn("k8s-network")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const feedPath = "/network-flows?limit=1";
    const feed = yield* decodeBody(Feed, feedPath)(yield* api.json(org.id, feedPath));
    const clusters = feed.accounts.filter((a) => a.supportsFlows && a.recut);
    if (clusters.length === 0) {
      return yield* new CliFailure({
        message:
          "No Kubernetes account reports pod network traffic in this organization. Add a Kubernetes account and turn on network flow collection.",
      });
    }
    const wanted = input.cluster.join(" ");
    const [only] = clusters;
    let accountId: string;
    if (wanted) {
      accountId = (yield* findAccount(
        clusters.map((a) => ({
          id: a.accountId,
          pluginId: a.pluginId,
          displayName: a.displayName,
        })),
        wanted,
      )).id;
    } else if (only && clusters.length === 1) {
      accountId = only.accountId;
    } else {
      return yield* new CliFailure({
        message: `Several clusters report network traffic; name one: ${clusters.map((a) => a.displayName).join(", ")}.`,
      });
    }

    const { from, to } = resolveDateRange(input, 14);
    const params = new URLSearchParams({ from, to });
    if (Option.isSome(input.limit)) params.set("limit", String(input.limit.value));
    const path = `/network-flows/kubernetes/${encodeURIComponent(accountId)}?${params.toString()}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") return yield* Print.json(body);
    const report = yield* decodeBody(Report, path)(body);

    yield* Print.line(
      `${c.bold(`~${formatMoney(report.totals.estimatedCost, report.currency)}`)} ${c.dim(
        `· estimated at list price · ${safe(report.displayName)} · ${report.range.from} → ${report.range.to} · ${formatBytes(report.totals.bytes)}`,
      )}`,
    );
    if (report.billed.billedCost !== null) {
      yield* Print.line(
        `${formatMoney(report.billed.billedCost, report.currency)} billed · ${c.bold(
          formatMoney(report.totals.allocatedCost ?? 0, report.currency),
        )} allocated to workloads · ${c.yellow(
          `${formatMoney(report.totals.unallocatedCost ?? 0, report.currency)} unallocated`,
        )}${report.billed.basis === "bytes" ? c.yellow(" · split by bytes alone (weakest basis)") : ""}`,
      );
    } else {
      yield* Print.line(
        c.dim("No billed data-transfer source set: figures are list-price estimates."),
      );
    }
    if (report.billed.error) yield* Print.line(c.red(safe(report.billed.error)));
    if (report.totals.bytes > 0 && report.methods.length > 0) {
      yield* Print.line(
        c.dim(
          report.methods
            .map(
              (m) =>
                `${methodLabel(m.method)} ${Math.round((m.bytes / report.totals.bytes) * 100)}%`,
            )
            .join(" · "),
        ),
      );
    }

    for (const source of report.collection?.sources ?? []) {
      if (!source.usable && source.unusableReason) {
        yield* Print.line(c.dim(`· ${safe(source.unusableReason)}`));
      }
    }
    if (report.collection?.lastError) yield* Print.line(c.red(safe(report.collection.lastError)));

    if (report.scopes.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("By traffic class"));
      for (const line of barChart(
        report.scopes.map((s) => ({
          label: scopeLabel(s.scope),
          value: s.allocatedCost ?? s.estimatedCost,
          display: `${formatMoney(s.allocatedCost ?? s.estimatedCost, report.currency)} ${c.dim(formatBytes(s.bytes))}`,
        })),
      )) {
        yield* Print.line(line);
      }
    }

    const columns: Column<Row>[] = [
      { header: "name", value: (r) => safe(r.label) },
      { header: "mostly", value: (r) => c.dim(topScope(r)) },
      { header: "source", value: (r) => c.dim(methodLabel(r.method)) },
      { header: "bytes", value: (r) => formatBytes(r.bytes), align: "right" },
      {
        header: report.billed.billedCost !== null ? "allocated" : "estimated",
        value: (r) => rowMoney(report, r),
        align: "right",
      },
    ];
    if (report.namespaces.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("By namespace"));
      yield* Print.table(report.namespaces.slice(0, 15), columns);
    }
    if (report.workloads.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("By workload"));
      yield* Print.table(report.workloads.slice(0, 20), columns);
    }
    if (report.topTalkers.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("Top talkers"));
      for (const pair of report.topTalkers.slice(0, 15)) {
        yield* Print.line(
          `  ${safe(pair.source.label || pair.source.ref)} → ${safe(pair.destination.label || pair.destination.ref)} ${c.dim(
            `${scopeLabel(pair.scope)} · ${formatBytes(pair.bytes)}`,
          )} ${formatMoney(pair.estimatedCost, pair.currency)}`,
        );
      }
    }
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Derived, never collected: these bytes also leave through the nodes, so they are kept out of org-wide network totals and never added to the cost store.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "A Kubernetes cluster's network costs by traffic class, namespace and workload",
  ),
);
