// `infrawrench canvas`: the org's cost canvases (reports built from a
// description by the chat agent), their definitions, and refreshing one.
//
// A canvas stores queries, never numbers, so `refresh` is the interesting
// verb: it re-runs every block server-side (no model call) and prints the
// figures. `--json` carries the full run result, chart series included.
//
// client-core imports are type-only, so the CLI still ships zero new runtime
// dependencies; the little formatting needed is re-derived here.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  CostCanvas,
  CostCanvasKpiUnit,
  CostCanvasRunResult,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import { destination, destinationOf, pdfFormat } from "../effect/file-flags";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { decodePaired, knownOr, Unrecognized, wire } from "../effect/wire";
import { formatUnitCostRatio, matchCostReport, unitCostRatioLabel } from "../format";
import { c, formatMoney, safe } from "../output";
import { sparkline } from "../charts";
import { exportPdf, requirePdfForDestination } from "../pdf-export";

const CANVASES_PATH = "/cost-canvases";

/**
 * A block, flat: `kind` picks which of the optional parts a description
 * reads, and a kind this build does not describe falls back to its title.
 */
const Block = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  metric: Schema.optional(Schema.Struct({ type: Schema.String })),
  config: Schema.optional(Schema.Struct({ chartType: Schema.String, groupBy: Schema.String })),
  query: Schema.optional(Schema.Struct({ groupBy: Schema.String, binning: Schema.String })),
});
type Block = typeof Block.Type;

const Canvas = wire<CostCanvas>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    prompt: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
    spec: Schema.Struct({ blocks: Schema.Array(Block) }),
    placements: Schema.Array(Schema.Struct({ dashboardName: Schema.String })),
  }),
);
type Canvas = typeof Canvas.Type;
const Canvases = Schema.Array(Canvas);

const Kpi = Schema.Struct({
  value: Schema.NullOr(Schema.Finite),
  unit: knownOr(["money", "money_per_unit", "percent", "count"]),
  currency: Schema.optional(Schema.String),
  perUnit: Schema.optional(Schema.String),
  changePercent: Schema.optional(Schema.NullOr(Schema.Finite)),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});
type Kpi = typeof Kpi.Type;

const Cost = Schema.Struct({
  currencies: Schema.Array(Schema.String),
  totals: Schema.Record(Schema.String, Schema.Finite),
  series: Schema.Array(
    Schema.Struct({
      currency: Schema.String,
      points: Schema.Array(Schema.Struct({ bucket: Schema.String, amount: Schema.Finite })),
    }),
  ),
});

const UNIT_COST_MODES = ["unit_cost", "margin", "usage_unit_cost", "raw_metric"] as const;

const UnitCost = Schema.Struct({
  mode: knownOr(UNIT_COST_MODES),
  scale: Schema.Finite,
  usageUnit: Schema.optional(Schema.String),
  metric: Schema.NullOr(Schema.Struct({ unit: Schema.String })),
  series: Schema.Array(
    Schema.Struct({ currency: Schema.String, overallValue: Schema.NullOr(Schema.Finite) }),
  ),
});

/** A block's result, flat like {@link Block}: `kind` says which parts are there. */
const BlockResult = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  error: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  kpi: Schema.optional(Schema.NullOr(Kpi)),
  table: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        columns: Schema.Array(Schema.String),
        rows: Schema.Array(
          Schema.Struct({
            label: Schema.String,
            values: Schema.Array(Schema.Finite),
            total: Schema.Finite,
          }),
        ),
        currency: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  cost: Schema.optional(Cost),
  unitCost: Schema.optional(UnitCost),
  report: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  budgets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        currency: Schema.String,
        amountCents: Schema.Finite,
        actualCents: Schema.Finite,
      }),
    ),
  ),
  anomalies: Schema.optional(
    Schema.Array(
      Schema.Struct({
        day: Schema.String,
        dimension: Schema.String,
        dimensionKey: Schema.String,
        currency: Schema.String,
        actualCents: Schema.Finite,
      }),
    ),
  ),
  withheld: Schema.optional(Schema.Boolean),
  graph: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  spec: Schema.optional(
    Schema.NullOr(Schema.Struct({ chart: Schema.Struct({ type: Schema.String }) })),
  ),
});
type BlockResult = typeof BlockResult.Type;

const RunResult = wire<CostCanvasRunResult>()(
  Schema.Struct({ ranAt: Schema.String, blocks: Schema.Array(BlockResult) }),
);

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Canvases live in Infrawrench Cloud: they are built by the cloud chat agent over collected spend.",
    });
  }
});

const findCanvas = Effect.fnUntraced(function* (query: string) {
  if (!query.trim()) {
    return yield* new CliFailure({ message: "Which canvas? `infrawrench canvas show <name|id>`." });
  }
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const canvases = yield* decodePaired(
    Canvases,
    CANVASES_PATH,
  )(yield* api.json(org.id, CANVASES_PATH));
  const found = matchCostReport(
    canvases.map((x) => ({ id: x.row.id, name: x.row.name, paired: x })),
    query,
  );
  if (found.match) return { org, canvas: found.match.paired.row, raw: found.match.paired.raw };
  if (found.candidates.length > 1) {
    return yield* new CliFailure({
      message: `"${query}" matches ${found.candidates.length} canvases: ${found.candidates.map((x) => x.name).join(", ")}. Use the id.`,
    });
  }
  return yield* new CliFailure({
    message: `No canvas matches "${query}". \`infrawrench canvas list\` shows them.`,
  });
});

/** One block, compactly: `kpi · Monthly AI spend`. */
function describeBlock(block: Block): string {
  switch (block.kind) {
    case "text": {
      const first = (block.text ?? "").split("\n").find((l) => l.trim()) ?? "";
      return safe(first.replace(/^#+\s*/, "").slice(0, 60));
    }
    case "kpi":
      return safe(`${block.title ?? ""} (${block.metric?.type ?? ""})`);
    case "chart": {
      const config = block.config;
      if (!config) break;
      return safe(
        `${block.title ?? ""} (${config.chartType.replace("_", " ")}, ${config.groupBy === "none" ? "ungrouped" : `by ${config.groupBy}`})`,
      );
    }
    case "table":
      if (!block.query) break;
      return safe(`${block.title ?? ""} (by ${block.query.groupBy}, ${block.query.binning})`);
  }
  return safe(block.title || block.kind);
}

/** A KPI's figure. Mirrors client-core's `formatCostCanvasKpi`. */
export function formatKpi(
  kpi:
    | {
        value: number | null;
        unit: CostCanvasKpiUnit | Unrecognized;
        currency?: string | undefined;
        perUnit?: string | undefined;
      }
    | null
    | undefined,
): string {
  if (!kpi || kpi.value === null) return "-";
  if (kpi.unit instanceof Unrecognized) return String(kpi.value);
  switch (kpi.unit) {
    case "money":
      return formatMoney(kpi.value, kpi.currency ?? "USD");
    case "money_per_unit":
      return `${formatMoney(kpi.value, kpi.currency ?? "USD")}${kpi.perUnit ? ` / ${safe(kpi.perUnit)}` : ""}`;
    case "percent":
      return `${Math.round(kpi.value)}%`;
    case "count":
      return String(Math.round(kpi.value));
  }
}

function formatChange(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "";
  const s = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  return pct >= 0 ? c.red(s) : c.green(s);
}

const printBlockResult = Effect.fnUntraced(function* (block: Block, r: BlockResult) {
  const title = block.kind === "text" ? "" : safe(block.title || block.kind);
  if (r.error) {
    yield* Print.line(`${c.bold(title || "Text")}  ${c.red(safe(r.error))}`);
    return yield* Print.line();
  }
  switch (r.kind) {
    case "text":
      for (const line of (r.text ?? "").split("\n")) {
        const text = safe(line);
        yield* Print.line(text.startsWith("#") ? c.bold(text.replace(/^#+\s*/, "")) : text);
      }
      break;
    case "kpi": {
      const change = formatChange(r.kpi?.changePercent);
      yield* Print.line(
        `${c.bold(title)}  ${formatKpi(r.kpi)}${change ? `  ${change} vs previous` : ""}${
          r.kpi?.from && r.kpi.to ? c.dim(`  (${r.kpi.from} → ${r.kpi.to})`) : ""
        }`,
      );
      if (r.kpi?.note) yield* Print.line(c.dim(`  ${safe(r.kpi.note)}`));
      break;
    }
    case "table": {
      yield* Print.line(c.bold(title));
      const t = r.table;
      if (!t || t.rows.length === 0) {
        yield* Print.line(c.dim("  no spend in this window"));
        break;
      }
      const currency = t.currency ?? "USD";
      const cols = t.columns.length > 6 ? t.columns.slice(-6) : t.columns;
      const offset = t.columns.length - cols.length;
      type Row = (typeof t.rows)[number];
      yield* Print.table(t.rows, [
        { header: "", value: (row: Row) => safe(row.label) },
        ...(t.columns[0] === "total"
          ? []
          : cols.map((col, i) => ({
              header: safe(col.slice(0, 7)),
              value: (row: Row) => formatMoney(row.values[i + offset] ?? 0, currency),
            }))),
        { header: "total", value: (row: Row) => c.bold(formatMoney(row.total, currency)) },
      ]);
      break;
    }
    case "chart":
    case "cost_report": {
      const name = r.kind === "cost_report" ? safe(r.report?.name ?? title) : title;
      const window = c.dim(`  (${r.from ?? ""} → ${r.to ?? ""})`);
      if (r.cost) {
        const currency = r.cost.currencies[0] ?? "USD";
        const buckets = new Map<string, number>();
        for (const s of r.cost.series.filter((x) => x.currency === currency)) {
          for (const p of s.points) buckets.set(p.bucket, (buckets.get(p.bucket) ?? 0) + p.amount);
        }
        const values = [...buckets.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, v]) => v);
        yield* Print.line(
          `${c.bold(name)}  ${formatMoney(r.cost.totals[currency] ?? 0, currency)}  ${c.cyan(sparkline(values, Math.min(40, values.length)))}${window}`,
        );
      } else if (r.unitCost) {
        const u = r.unitCost;
        const s = u.series[0];
        // A calculation this build does not know formats as a plain unit cost,
        // which is what the shared formatters do with any mode but these.
        const mode = u.mode instanceof Unrecognized ? "unit_cost" : u.mode;
        // Cost per usage unit has no metric: its unit is the usage unit.
        const unit =
          mode === "usage_unit_cost" ? (u.usageUnit ?? "unit") : (u.metric?.unit ?? "unit");
        const value =
          s && s.overallValue !== null
            ? `${formatUnitCostRatio(s.overallValue, mode)} ${safe(unitCostRatioLabel(mode, s.currency, unit, u.scale))}`
            : "-";
        yield* Print.line(`${c.bold(name)}  ${value}${window}`);
      } else {
        yield* Print.line(`${c.bold(name)}  ${c.dim("(chart)")}`);
      }
      break;
    }
    case "budgets": {
      yield* Print.line(c.bold(title));
      const budgets = r.budgets ?? [];
      for (const b of budgets) {
        const pct = b.amountCents > 0 ? Math.round((b.actualCents / b.amountCents) * 100) : 0;
        yield* Print.line(
          `  ${safe(b.name)}  ${formatMoney(b.actualCents / 100, b.currency)} of ${formatMoney(b.amountCents / 100, b.currency)} ${pct >= 100 ? c.red(`${pct}%`) : `${pct}%`}`,
        );
      }
      if (budgets.length === 0) yield* Print.line(c.dim("  no budgets"));
      break;
    }
    case "anomalies": {
      yield* Print.line(c.bold(title));
      const anomalies = r.anomalies ?? [];
      if (r.withheld) {
        yield* Print.line(c.dim("  withheld: anomalies are org-wide and your cost view is scoped"));
      } else if (anomalies.length === 0) yield* Print.line(c.dim("  none in this window"));
      for (const a of anomalies) {
        yield* Print.line(
          `  ${a.day}  ${safe(a.dimension)}: ${safe(a.dimensionKey)}  ${formatMoney(a.actualCents / 100, a.currency)}`,
        );
      }
      break;
    }
    case "custom_graph":
      yield* Print.line(
        `${c.bold(title || safe(r.graph?.name) || "Custom graph")}  ${c.dim(r.spec ? `(${safe(r.spec.chart.type)})` : "(no output)")}`,
      );
      break;
  }
  yield* Print.line();
});

const pdfFlags = (command: string) => ({ format: pdfFormat(command), ...destination });

const name = Argument.String("name|id").pipe(
  Argument.withDescription("The canvas (the words join into one name)"),
  Argument.variadic(),
);

/** Write the canvas's PDF, when `--format pdf` asked for it; false when it did not. */
const maybePdf = Effect.fnUntraced(function* (
  orgId: string,
  canvas: Canvas,
  pdf: boolean,
  target: Option.Option<string>,
) {
  if (!pdf) return false;
  yield* exportPdf({
    orgId,
    path: `/cost-canvases/${encodeURIComponent(canvas.id)}/pdf`,
    target,
    subject: { kind: "canvas", id: canvas.id, name: canvas.name },
  });
  return true;
});

const askedPdfOfList = new CliFailure({
  message: "Which canvas? `infrawrench canvas show <name|id> --format pdf`.",
});

/** `infrawrench canvas list` */
const listCanvases = Effect.fn("canvas.list")(function* () {
  yield* requireCloud;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, CANVASES_PATH);
  if (session.output === "json") return yield* Print.json({ org: org.id, canvases: body });
  const canvases = yield* decodeBody(Canvases, CANVASES_PATH)(body);
  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("· canvases")}`);
  yield* Print.line();
  if (canvases.length === 0) {
    return yield* Print.line(
      c.dim(
        "No canvases. Describe a report on the Canvases page (web or desktop) and the assistant builds it; refresh it here by name.",
      ),
    );
  }
  yield* Print.table(canvases, [
    { header: "name", value: (x) => c.bold(safe(x.name)) },
    { header: "blocks", value: (x) => String(x.spec.blocks.length) },
    {
      header: "dashboards",
      value: (x) =>
        x.placements.length === 0
          ? c.dim("—")
          : x.placements.map((p) => safe(p.dashboardName)).join(", "),
    },
    { header: "updated", value: (x) => c.dim(x.updatedAt.slice(0, 10)) },
  ]);
});

const list = Command.make(
  "list",
  {
    // Only to point at `canvas show` when a PDF is asked of the whole list.
    format: Flag.String("format").pipe(Flag.withHidden, Flag.optional),
  },
  (input) => (Option.isSome(input.format) && input.format.value ? askedPdfOfList : listCanvases()),
).pipe(Command.withDescription("Cost canvases: reports the chat agent built from a description"));

/** `infrawrench canvas show <name|id>`: the definition, not the numbers. */
const show = Command.make(
  "show",
  { name, ...pdfFlags("canvas show") },
  Effect.fn("canvas.show")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const { org, canvas, raw } = yield* findCanvas(input.name.join(" "));
    const target = destinationOf(input);
    yield* requirePdfForDestination(input.format, target, "canvas show");
    if (yield* maybePdf(org.id, canvas, input.format, target)) return;
    if (session.output === "json") return yield* Print.json({ org: org.id, canvas: raw });
    yield* Print.line(`${c.bold(safe(canvas.name))} ${c.dim(`· ${canvas.id}`)}`);
    if (canvas.description) yield* Print.line(c.dim(safe(canvas.description)));
    yield* Print.line();
    yield* Print.keyValues([
      ["prompt", canvas.prompt === null ? c.dim("(written directly)") : safe(canvas.prompt)],
      ["blocks", String(canvas.spec.blocks.length)],
      [
        "dashboards",
        canvas.placements.length === 0
          ? c.dim("none")
          : canvas.placements.map((p) => safe(p.dashboardName)).join(", "),
      ],
      ["updated", canvas.updatedAt],
    ]);
    yield* Print.line();
    for (const [i, b] of canvas.spec.blocks.entries()) {
      yield* Print.line(
        `${c.dim(String(i + 1).padStart(2))}  ${c.cyan(safe(b.kind).padEnd(12))} ${describeBlock(b)}`,
      );
    }
    yield* Print.line();
    yield* Print.line(c.dim(`Run it: infrawrench canvas refresh "${safe(canvas.name)}"`));
  }),
).pipe(
  Command.withDescription(
    "One canvas's definition: blocks, placements, prompt (--format pdf saves the rendered canvas)",
  ),
);

/** `infrawrench canvas refresh <name|id>`: re-run every query and print the figures. */
const refreshCanvas = Effect.fnUntraced(function* (input: {
  readonly name: ReadonlyArray<string>;
  readonly format: boolean;
  readonly out: Option.Option<string>;
  readonly file: Option.Option<string>;
}) {
  yield* requireCloud;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const { org, canvas } = yield* findCanvas(input.name.join(" "));
  const target = destinationOf(input);
  yield* requirePdfForDestination(input.format, target, "canvas refresh");
  if (yield* maybePdf(org.id, canvas, input.format, target)) return;
  const path = `/cost-canvases/${encodeURIComponent(canvas.id)}/run`;
  const body = yield* api.json(org.id, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeChartData: true }),
  });
  if (session.output === "json") {
    return yield* Print.json({
      org: org.id,
      canvas: { id: canvas.id, name: canvas.name },
      result: body,
    });
  }
  const result = yield* decodeBody(RunResult, path)(body);
  yield* Print.line(`${c.bold(safe(canvas.name))} ${c.dim(`· refreshed ${result.ranAt}`)}`);
  yield* Print.line();
  const byId = new Map(result.blocks.map((b) => [b.id, b]));
  for (const block of canvas.spec.blocks) {
    const r = byId.get(block.id);
    if (r) yield* printBlockResult(block, r);
  }
});

const refreshDescription =
  "Re-run a canvas's queries (no model call) and print its figures (--format pdf saves it)";

export const canvas = Command.make(
  "canvas",
  // A bare name refreshes: the verb people reach for.
  { name, ...pdfFlags("canvas refresh") },
  Effect.fn("canvas")(function* (input) {
    if (input.name.length === 0) {
      if (input.format) return yield* askedPdfOfList;
      return yield* listCanvases();
    }
    yield* refreshCanvas(input);
  }),
).pipe(
  Command.withAlias("canvases"),
  Command.withDescription("Cost canvases: list, show one, or refresh one by name"),
  Command.withSubcommands([
    list,
    show,
    Command.make("refresh", { name, ...pdfFlags("canvas refresh") }, refreshCanvas).pipe(
      Command.withDescription(refreshDescription),
    ),
    Command.make("run", { name, ...pdfFlags("canvas refresh") }, refreshCanvas).pipe(
      Command.withDescription(refreshDescription),
    ),
  ]),
);
