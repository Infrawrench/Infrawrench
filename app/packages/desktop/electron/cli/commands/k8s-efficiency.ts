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
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  K8sCostCategory,
  KubernetesEfficiencyConfig,
  KubernetesEfficiencyReport,
  KubernetesEfficiencyResult,
  KubernetesEfficiencyRowKind,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import { destination, destinationOf, formatOf, writeOrPrint } from "../effect/file-flags";
import * as Print from "../effect/print";
import { basis, dateRange, groupBy, resolveDateRange } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { matchCostReport } from "../format";
import { c, formatMoney, safe } from "../output";
import { barChart } from "../charts";

// Restated rather than imported: the CLI takes type-only imports from
// workspace packages.
const CATEGORY_LABELS: Partial<Record<string, string>> = {
  cpu: "CPU",
  memory: "Memory",
  gpu: "GPU",
  storage: "Storage",
  network: "Network",
  control_plane: "Control plane",
  compute: "CPU and memory (combined)",
} satisfies Record<K8sCostCategory, string>;
const ROW_KIND_LABELS: Partial<Record<string, string>> = {
  idle: "Idle capacity",
  overhead: "Cluster overhead",
  unattributed: "(no value)",
} satisfies Record<Exclude<KubernetesEfficiencyRowKind, "group">, string>;
const FIXED_GROUP_BYS = ["cluster", "namespace", "workload", "node_pool", "category"] as const;

const LIST_PATH = "/k8s-efficiency-reports";

const Report = wire<KubernetesEfficiencyReport>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    config: Schema.Struct({
      groupBy: Schema.String,
      groupByLabelKey: Schema.optional(Schema.String),
      basis: Schema.String,
      idle: Schema.String,
    }),
  }),
);
const Reports = Schema.Array(Report);

const Figures = Schema.Struct({
  total: Schema.Finite,
  used: Schema.Finite,
  unused: Schema.Finite,
  unmeasured: Schema.Finite,
  idle: Schema.Finite,
  overhead: Schema.Finite,
  efficiency: Schema.NullOr(Schema.Finite),
  measuredShare: Schema.NullOr(Schema.Finite),
});
type Figures = typeof Figures.Type;

const Result = wire<KubernetesEfficiencyResult>()(
  Schema.Struct({
    from: Schema.String,
    to: Schema.String,
    groupBy: Schema.String,
    groupByLabelKey: Schema.optional(Schema.String),
    idle: Schema.String,
    basis: Schema.String,
    includesLegacyRows: Schema.Boolean,
    currencies: Schema.Array(
      Schema.Struct({
        currency: Schema.String,
        totals: Figures,
        categories: Schema.Array(Schema.Struct({ category: Schema.String, figures: Figures })),
        rows: Schema.Array(
          Schema.Struct({ kind: Schema.String, label: Schema.String, figures: Figures }),
        ),
      }),
    ),
  }),
);
type Result = typeof Result.Type;

/** A saved report's run: its name, and the result as the server sent it. */
const Run = Schema.Struct({ name: Schema.String, result: Schema.Unknown });

const decodeGroupBy = Schema.decodeUnknownOption(Schema.Literals(FIXED_GROUP_BYS));

/**
 * `--group-by` to a config's grouping: a fixed one, or any label key. Null
 * for a value that is only space.
 */
export function parseEfficiencyGroupBy(
  raw: string,
): Pick<KubernetesEfficiencyConfig, "groupBy" | "groupByLabelKey"> | null {
  const value = raw.trim();
  if (!value) return null;
  const fixed = decodeGroupBy(value);
  if (Option.isSome(fixed)) return { groupBy: fixed.value };
  // `tag:team`, `label:team` and a bare key all group by that tag key;
  // `k8s_pod_label:team` and friends are already tag keys.
  return { groupBy: "label", groupByLabelKey: value.replace(/^(tag|label):/, "") };
}

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Kubernetes efficiency reports live in Infrawrench Cloud: they read the cost the cloud collects from each cluster.",
    });
  }
});

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

const grouping = (r: { groupBy: string; groupByLabelKey?: string | undefined }) =>
  safe(r.groupBy === "label" ? (r.groupByLabelKey ?? "label") : r.groupBy);

const listReports = Effect.fnUntraced(function* (
  org: { id: string; displayName: string },
  body: unknown,
) {
  const session = yield* CliSession;
  if (session.output === "json") return yield* Print.json({ org: org.id, reports: body });
  const reports = yield* decodeBody(Reports, LIST_PATH)(body);
  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("· Kubernetes efficiency reports")}`);
  yield* Print.line();
  if (reports.length === 0) {
    return yield* Print.line(
      c.dim(
        "No saved reports. Create one on the Kubernetes efficiency page, or run one ad hoc: `infrawrench k8s-efficiency --group-by namespace`.",
      ),
    );
  }
  yield* Print.table(reports, [
    { header: "name", value: (r) => c.bold(safe(r.name)) },
    { header: "grouped by", value: (r) => grouping(r.config) },
    { header: "basis", value: (r) => safe(r.config.basis) },
    { header: "idle", value: (r) => safe(r.config.idle) },
    { header: "id", value: (r) => c.dim(r.id) },
  ]);
});

const printBlock = Effect.fnUntraced(function* (block: Result["currencies"][number]) {
  const money = (n: number) => formatMoney(n, block.currency);
  const t = block.totals;
  yield* Print.line();
  yield* Print.line(
    `${c.bold(money(t.total))} ${c.dim("total")} · ${c.bold(pct(t.efficiency))} ${c.dim("efficient")}${
      t.measuredShare !== null && t.measuredShare < 0.999
        ? c.yellow(` · ${pct(t.measuredShare)} measured`)
        : ""
    }`,
  );
  yield* Print.line(
    c.dim(
      `used ${money(t.used)} · requested, unused ${money(t.unused)} · unmeasured ${money(t.unmeasured)} · idle ${money(t.idle)} · overhead ${money(t.overhead)}`,
    ),
  );

  if (block.categories.length > 0) {
    yield* Print.line();
    yield* Print.line(c.bold("By cost category"));
    for (const line of barChart(
      block.categories.map(({ category, figures }) => ({
        label: CATEGORY_LABELS[category] ?? safe(category),
        value: figures.total,
        display: `${money(figures.total)} ${c.dim(pct(figures.efficiency))}`,
      })),
    )) {
      yield* Print.line(line);
    }
  }

  yield* Print.line();
  const cell = (pick: (f: Figures) => number) => (f: Figures) => money(pick(f));
  yield* Print.table(block.rows, [
    {
      header: "group",
      value: (r) =>
        r.kind === "group" ? safe(r.label) : c.dim(ROW_KIND_LABELS[r.kind] ?? safe(r.kind)),
    },
    { header: "total", value: (r) => cell((f) => f.total)(r.figures), align: "right" },
    { header: "used", value: (r) => cell((f) => f.used)(r.figures), align: "right" },
    { header: "unused", value: (r) => cell((f) => f.unused)(r.figures), align: "right" },
    { header: "unmeasured", value: (r) => cell((f) => f.unmeasured)(r.figures), align: "right" },
    { header: "idle", value: (r) => cell((f) => f.idle)(r.figures), align: "right" },
    { header: "overhead", value: (r) => cell((f) => f.overhead)(r.figures), align: "right" },
    { header: "efficiency", value: (r) => pct(r.figures.efficiency), align: "right" },
  ]);
});

const printResult = Effect.fnUntraced(function* (name: string, result: Result) {
  yield* Print.line(
    `${c.bold(safe(name))} ${c.dim(
      `· ${result.from} → ${result.to} · by ${grouping(result)} · efficiency of ${
        result.basis === "allocated" ? "allocated" : "total"
      } cost · idle ${safe(result.idle)}`,
    )}`,
  );
  if (result.includesLegacyRows) {
    yield* Print.line(
      c.dim(
        "Part of this window predates the CPU/memory and usage split: that cost is shown as combined and unmeasured.",
      ),
    );
  }
  if (result.currencies.length === 0) {
    yield* Print.line();
    return yield* Print.line(
      c.dim(
        "No Kubernetes cost in this window. A cluster reports cost once its node prices are known (from its cloud account, or the Kubernetes account's node rates field).",
      ),
    );
  }
  for (const block of result.currencies) yield* printBlock(block);
});

export const k8sEfficiency = Command.make(
  "k8s-efficiency",
  {
    query: Argument.String("name|id").pipe(
      Argument.withDescription("A saved report to run (the words join into one name)"),
      Argument.variadic(),
    ),
    groupBy: groupBy.pipe(
      Flag.withDescription(
        "Run an unsaved report by cluster, namespace, workload, node_pool, category or a label key",
      ),
    ),
    basis: basis.pipe(Flag.withDescription("With --group-by: total (default) or allocated")),
    ...dateRange,
    format: formatOf(["csv", "ndjson"], () => "--format must be csv or ndjson."),
    ...destination,
  },
  Effect.fn("k8s-efficiency")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const query = input.query.join(" ");
    const format = input.format;
    const wantedGrouping = Option.getOrElse(input.groupBy, () => "");

    if (!query && !wantedGrouping) {
      if (Option.isSome(format)) {
        return yield* new CliFailure({
          message: "Which report? `infrawrench k8s-efficiency <name|id> --format csv`.",
        });
      }
      return yield* listReports(org, yield* api.json(org.id, LIST_PATH));
    }

    let name: string;
    let rawResult: unknown;
    let path: string;
    if (query) {
      const reports = yield* api.decode(Reports, org.id, LIST_PATH);
      const found = matchCostReport(reports, query);
      if (!found.match) {
        return yield* new CliFailure({
          message:
            found.candidates.length === 0
              ? `No Kubernetes efficiency report matches "${query}". Run \`infrawrench k8s-efficiency\` to list them.`
              : `"${query}" matches ${found.candidates.length} reports: ${found.candidates
                  .map((r) => r.name)
                  .join(", ")}. Use the full name or the id.`,
        });
      }
      const id = encodeURIComponent(found.match.id);
      if (Option.isSome(format)) {
        const body = yield* api.text(
          org.id,
          `/k8s-efficiency-reports/${id}/export?format=${format.value}&perPeriod=true`,
        );
        return yield* writeOrPrint(destinationOf(input), body);
      }
      path = `/k8s-efficiency-reports/${id}/run`;
      const run = yield* api.decode(Run, org.id, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      name = run.name;
      rawResult = run.result;
    } else {
      if (Option.isSome(format)) {
        return yield* new CliFailure({ message: "--format exports a saved report: name one." });
      }
      const basisValue = Option.getOrUndefined(input.basis);
      if (basisValue && basisValue !== "total" && basisValue !== "allocated") {
        return yield* new CliFailure({
          message: "--basis must be total or allocated for k8s-efficiency.",
        });
      }
      const grouped = parseEfficiencyGroupBy(wantedGrouping);
      if (!grouped) return yield* new CliFailure({ message: "--group-by needs a value." });
      const { from, to } = resolveDateRange(input);
      const config: KubernetesEfficiencyConfig = {
        version: 1,
        dateRange: { kind: "absolute", from, to },
        granularity: "day",
        filters: [],
        ...grouped,
        idle: "separate",
        basis: basisValue === "allocated" ? "allocated" : "total",
      };
      name = "Kubernetes efficiency";
      path = "/k8s-efficiency-reports/query";
      rawResult = yield* api.json(org.id, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
    }

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id, name }, rawResult, path));
    }
    yield* printResult(name, yield* decodeBody(Result, path)(rawResult));
  }),
).pipe(
  Command.withDescription(
    "Kubernetes efficiency reports: list, run one, or --group-by an unsaved one (cloud only)",
  ),
);
