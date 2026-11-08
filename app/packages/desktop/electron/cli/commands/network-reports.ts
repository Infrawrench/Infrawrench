// `infrawrench network-reports [name|id]`: saved network flow reports. Lists
// them, or runs one: bytes and estimated cost over time by the report's
// grouping, the group totals and the top talking pairs. Text output is
// hand-rolled (tables and a sparkline); `--json` prints the server's result
// as is; `--format csv` writes the series CSV and `--format pairs-csv` the
// top-talkers CSV, the same files the web and desktop export buttons save.
//
// Cloud-only: flows are collected server-side into the network-flow store.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  NetworkFlowReport,
  NetworkFlowReportGroupBy,
  NetworkFlowReportNotice,
  NetworkFlowReportResult,
  NetworkFlowReportRunResult,
  NetworkFlowReportSeries,
  NetworkFlowReportTalker,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import { destination, destinationOf, formatOf, writeOrPrint } from "../effect/file-flags";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { decodePaired, knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { sparkline } from "../charts";
import { matchCostReport } from "../format";
import { c, type Column, formatMoney, safe } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

const NOTICE_TEXT: Partial<Record<string, string>> = {
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
} satisfies Record<NetworkFlowReportNotice, string>;

const UNATTRIBUTED_REF = "infrawrench:unattributed";

const LIST_PATH = "/network-flows/reports";

// Restated for `knownOr`: the CLI's client-core imports are type-only at
// module scope. `wire` fails the build when client-core adds a value.
const SCOPES = [
  "intra_zone",
  "cross_zone",
  "cross_region",
  "internet_egress",
  "internet_ingress",
  "provider_service",
  "nat_gateway",
  "private_interconnect",
  "unknown",
] as const;
const GROUP_BYS = [
  "none",
  "pair",
  "source",
  "destination",
  "traffic_class",
  "service",
  "zone_pair",
  "region_pair",
  "account",
  "network",
] as const;

const Report = wire<NetworkFlowReport>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    config: Schema.Struct({
      metric: Schema.String,
      granularity: Schema.String,
      groupBy: Schema.String,
    }),
  }),
);
const Reports = Schema.Array(Report);

const totals = {
  bytes: Schema.Finite,
  estimatedCost: Schema.Finite,
  sampledBytes: Schema.Finite,
  sampledCost: Schema.Finite,
  unattributedBytes: Schema.Finite,
  truncatedBytes: Schema.Finite,
};

const Series = Schema.Struct({
  id: Schema.String,
  groupKey: Schema.String,
  label: Schema.String,
  currency: Schema.String,
  points: Schema.Array(Schema.Struct({ bucket: Schema.String, ...totals })),
  total: Schema.Struct(totals),
});
type Series = typeof Series.Type;

const Endpoint = Schema.Struct({
  ref: Schema.String,
  label: Schema.String,
  zone: Schema.String,
  region: Schema.String,
  service: Schema.String,
  resourceTypeId: Schema.String,
  network: Schema.String,
});

const Talker = Schema.Struct({
  source: Endpoint,
  destination: Endpoint,
  scope: knownOr(SCOPES),
  direction: knownOr(["egress", "ingress"]),
  attribution: knownOr(["resolved", "unattributed"]),
  bytes: Schema.Finite,
  packets: Schema.Finite,
  estimatedCost: Schema.Finite,
  currency: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  pluginId: Schema.String,
  days: Schema.Finite,
  sampled: Schema.Boolean,
});
type Talker = typeof Talker.Type;

/**
 * The whole run result: the CSV writers are client-core's, and they take all
 * of it. Enums the text falls back on decode as strings; the ones the CSV
 * needs typed decode with `knownOr` and are projected in {@link forCsv}.
 */
const RunResult = wire<NetworkFlowReportRunResult>()(
  Schema.Struct({
    reportId: Schema.String,
    name: Schema.String,
    from: Schema.String,
    to: Schema.String,
    granularity: Schema.String,
    groupBy: knownOr(GROUP_BYS),
    metric: Schema.String,
    estimated: Schema.Boolean,
    buckets: Schema.Array(Schema.String),
    series: Schema.Array(Series),
    overall: Schema.Array(Series),
    groups: Schema.Array(
      Schema.Struct({
        groupKey: Schema.String,
        label: Schema.String,
        currency: Schema.String,
        pairCount: Schema.Finite,
        ...totals,
      }),
    ),
    groupCount: Schema.Finite,
    topTalkers: Schema.Array(Talker),
    sampledPluginIds: Schema.Array(Schema.String),
    notices: Schema.Array(Schema.String),
  }),
);
type RunResult = typeof RunResult.Type;

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "Network flow reports live in Infrawrench Cloud: flows are collected server-side.",
    });
  }
});

/** A label off one of client-core's tables, or the raw value a newer server sent. */
const label = (table: Partial<Record<string, string>>, value: string): string =>
  table[value] ?? safe(value);

const raw = <A extends string>(value: A | Unrecognized): string =>
  value instanceof Unrecognized ? value.raw : value;

function endpointName(core: Core, ref: string, name: string): string {
  if (ref === core.NETWORK_FLOW_REPORT_TRUNCATED_KEY) return "flows outside the stored top pairs";
  if (ref === UNATTRIBUTED_REF) return "unidentified peer";
  return safe(name || ref);
}

function groupName(core: Core, result: RunResult, key: string, name: string): string {
  if (key === core.NETWORK_FLOW_REPORT_OTHER_KEY) return "everything else";
  if (result.groupBy === "traffic_class") return label(core.NETWORK_FLOW_SCOPE_LABELS, key);
  if (result.groupBy === "source" || result.groupBy === "destination") {
    return endpointName(core, key, name);
  }
  if (key === "" && result.groupBy !== "none") return c.dim("(not set)");
  return safe(name || key);
}

const copySeries = (s: Series): NetworkFlowReportSeries => ({
  ...s,
  points: s.points.map((p) => ({ ...p })),
  total: { ...s.total },
});

/**
 * The result as the CSV writers take it. The series CSV reads no enum but
 * `groupBy`, and only against `"none"`, so a grouping this build does not
 * know is any other one; the pairs CSV prints each talker's traffic class,
 * direction and attribution, so a value this build does not know cannot be
 * written and is named instead.
 */
function forCsv(
  result: RunResult,
  pairs: boolean,
): { csv: NetworkFlowReportResult } | { unknown: string } {
  const groupBy: NetworkFlowReportGroupBy =
    result.groupBy instanceof Unrecognized ? "pair" : result.groupBy;
  const topTalkers: NetworkFlowReportTalker[] = [];
  for (const t of result.topTalkers) {
    const { scope, direction, attribution } = t;
    if (pairs) {
      const odd = [scope, direction, attribution].find((v) => v instanceof Unrecognized);
      if (odd instanceof Unrecognized) return { unknown: odd.raw };
    }
    topTalkers.push({
      ...t,
      source: { ...t.source },
      destination: { ...t.destination },
      scope: scope instanceof Unrecognized ? "unknown" : scope,
      direction: direction instanceof Unrecognized ? "egress" : direction,
      attribution: attribution instanceof Unrecognized ? "resolved" : attribution,
    });
  }
  return {
    csv: {
      from: result.from,
      to: result.to,
      groupBy,
      // Read by neither writer.
      granularity: "daily",
      metric: "both",
      estimated: true,
      notices: [],
      buckets: [...result.buckets],
      series: result.series.map(copySeries),
      overall: result.overall.map(copySeries),
      groups: result.groups.map((g) => ({ ...g })),
      groupCount: result.groupCount,
      topTalkers,
      sampledPluginIds: [...result.sampledPluginIds],
    },
  };
}

const printResult = Effect.fnUntraced(function* (core: Core, result: RunResult) {
  const showCost = result.metric !== "bytes";
  const showBytes = result.metric !== "cost";
  const groupByLabel = label(core.NETWORK_FLOW_REPORT_GROUP_BY_LABELS, raw(result.groupBy));
  yield* Print.line(
    `${c.bold(safe(result.name))} ${c.dim(
      `· ${result.from} to ${result.to} · ${label(core.NETWORK_FLOW_REPORT_GRANULARITY_LABELS, result.granularity).toLowerCase()}` +
        (result.groupBy !== "none" ? ` · by ${groupByLabel.toLowerCase()}` : ""),
    )}`,
  );
  yield* Print.line(
    c.dim("  Estimated from flow logs at list prices: it will not match the invoice."),
  );
  for (const n of result.notices) yield* Print.line(c.yellow(`  ${NOTICE_TEXT[n] ?? safe(n)}`));
  yield* Print.line();

  for (const s of result.overall) {
    const sampled = core.networkFlowSampledShare(s.total);
    const parts = [
      showCost ? `${c.bold(formatMoney(s.total.estimatedCost, s.currency))} estimated` : "",
      showBytes ? `${c.bold(core.formatFlowBytes(s.total.bytes))}` : "",
      sampled > 0 ? c.yellow(`${Math.round(sampled * 100)}% sampled`) : "",
      `${Math.round(core.attributionCoverage(s.total) * 100)}% attributed to a pair`,
    ].filter(Boolean);
    yield* Print.line(`${c.bold(safe(s.currency))}  ${parts.join("  ·  ")}`);
    const values = s.points.map((p) => (showCost ? p.estimatedCost : p.bytes));
    if (values.length > 1) {
      yield* Print.line(
        `     ${showCost ? "cost" : "bytes"}  ${sparkline(values, Math.min(48, values.length))}`,
      );
    }
  }
  yield* Print.line();

  if (result.groupBy !== "none" && result.groups.length > 0) {
    type Row = RunResult["groups"][number];
    const columns: Column<Row>[] = [
      {
        header: groupByLabel.toLowerCase(),
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
    yield* Print.table(result.groups, columns);
    if (result.groupCount > result.groups.length) {
      yield* Print.line(c.dim(`  ${result.groupCount - result.groups.length} more not listed.`));
    }
    yield* Print.line();
  }

  if (result.topTalkers.length === 0) {
    return yield* Print.line(c.dim("No flow pairs in this window for these filters."));
  }
  const columns: Column<Talker>[] = [
    { header: "source", value: (t) => endpointName(core, t.source.ref, t.source.label) },
    {
      header: "destination",
      value: (t) => endpointName(core, t.destination.ref, t.destination.label),
    },
    {
      header: "class",
      value: (t) =>
        `${label(core.NETWORK_FLOW_SCOPE_LABELS, raw(t.scope))}${t.direction === "ingress" ? " (in)" : ""}`,
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
  yield* Print.table(result.topTalkers, columns);
  if (result.topTalkers.some((t) => t.sampled)) {
    yield* Print.line(c.dim("* from a sampled flow source"));
  }
});

const listReports = Effect.fnUntraced(function* (
  core: Core,
  orgId: string,
  body: unknown,
  reports: ReadonlyArray<typeof Report.Type>,
) {
  const session = yield* CliSession;
  if (session.output === "json") return yield* Print.json({ org: orgId, reports: body });
  if (reports.length === 0) {
    return yield* Print.line(
      c.dim(
        "No network flow reports. Create one on the Costs page under Network, or with the infrawrench_network_flow_report Terraform resource.",
      ),
    );
  }
  yield* Print.table(reports, [
    { header: "report", value: (r) => safe(r.name) },
    {
      header: "shows",
      value: (r) => label(core.NETWORK_FLOW_REPORT_METRIC_LABELS, r.config.metric),
    },
    {
      header: "granularity",
      value: (r) => label(core.NETWORK_FLOW_REPORT_GRANULARITY_LABELS, r.config.granularity),
    },
    {
      header: "group by",
      value: (r) => label(core.NETWORK_FLOW_REPORT_GROUP_BY_LABELS, r.config.groupBy),
    },
    { header: "id", value: (r) => c.dim(r.id) },
  ]);
});

export const networkReports = Command.make(
  "network-reports",
  {
    query: Argument.String("name|id").pipe(
      Argument.withDescription("A report to run (the words join into one name)"),
      Argument.variadic(),
    ),
    format: formatOf(
      ["csv", "pairs-csv"],
      () => "--format takes csv or pairs-csv for network flow reports.",
    ),
    ...destination,
  },
  Effect.fn("network-reports")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const core: Core = yield* Effect.promise(() => import("@infrawrench/client-core"));
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, LIST_PATH);
    const reports = yield* decodePaired(Reports, LIST_PATH)(body);

    const query = input.query.join(" ");
    if (!query) {
      return yield* listReports(
        core,
        org.id,
        body,
        reports.map((r) => r.row),
      );
    }

    const found = matchCostReport(
      reports.map((r) => r.row),
      query,
    );
    if (!found.match) {
      return yield* new CliFailure({
        message:
          found.candidates.length > 1
            ? `"${query}" matches ${found.candidates.length} network flow reports: ${found.candidates.map((r) => r.name).join(", ")}. Use the id.`
            : `No network flow report named "${query}".`,
      });
    }
    const runPath = `/network-flows/reports/${encodeURIComponent(found.match.id)}/run`;
    const resultBody = yield* api.json(org.id, runPath, { method: "POST", body: "{}" });
    const result = yield* decodeBody(RunResult, runPath)(resultBody);

    if (Option.isSome(input.format)) {
      const pairs = input.format.value === "pairs-csv";
      const projected = forCsv(result, pairs);
      if ("unknown" in projected) {
        return yield* new CliFailure({
          message: `This server reports a flow value this version of the CLI does not know ("${safe(projected.unknown)}"), so it cannot write the pairs CSV. Update the desktop app, or export it from the Network tab.`,
        });
      }
      const csv = pairs
        ? core.networkFlowReportPairsToCsv(projected.csv)
        : core.networkFlowReportToCsv(projected.csv);
      return yield* writeOrPrint(destinationOf(input), csv);
    }
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, resultBody, runPath));
    }
    yield* printResult(core, result);
  }),
).pipe(
  Command.withDescription(
    "Saved network flow reports, or run one: bytes and estimated cost (cloud only)",
  ),
);
