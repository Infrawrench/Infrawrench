// `infrawrench canvas`: the org's cost canvases (reports built from a
// description by the chat agent), their definitions, and refreshing one.
//
// A canvas stores queries, never numbers, so `refresh` is the interesting
// verb: it re-runs every block server-side (no model call) and prints the
// figures. `--json` carries the full run result, chart series included.
//
// client-core imports are type-only, so the CLI still ships zero new runtime
// dependencies; the little formatting needed is re-derived here.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  CostCanvas,
  CostCanvasBlock,
  CostCanvasBlockResult,
  CostCanvasKpiValue,
  CostCanvasRunResult,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import {
  formatUnitCostRatio,
  matchCostReport,
  unitCostRatioLabel,
  type CliUnitCostMode,
} from "../format";
import { c, formatMoney, printJson, println, printKeyValues, printTable } from "../output";
import { sparkline } from "../charts";
import { exportPdf, wantsPdf, type PdfExportFlags } from "../pdf-export";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Canvases live in Infrawrench Cloud: they are built by the cloud chat agent over collected spend.",
    );
  }
}

async function findCanvas(
  ctx: CliContext,
  query: string,
): Promise<{ org: { id: string; displayName: string }; canvas: CostCanvas }> {
  if (!query.trim()) throw new CliError("Which canvas? `infrawrench canvas show <name|id>`.");
  const org = await resolveOrg(ctx);
  const canvases = await orgFetch<CostCanvas[]>(org.id, "/cost-canvases");
  const found = matchCostReport(canvases, query);
  if (found.match) return { org, canvas: found.match };
  if (found.candidates.length > 1) {
    throw new CliError(
      `"${query}" matches ${found.candidates.length} canvases: ${found.candidates.map((x) => x.name).join(", ")}. Use the id.`,
    );
  }
  throw new CliError(`No canvas matches "${query}". \`infrawrench canvas list\` shows them.`);
}

/** One block, compactly: `kpi · Monthly AI spend`. */
function describeBlock(block: CostCanvasBlock): string {
  switch (block.kind) {
    case "text": {
      const first = block.text.split("\n").find((l) => l.trim()) ?? "";
      return first.replace(/^#+\s*/, "").slice(0, 60);
    }
    case "kpi":
      return `${block.title} (${block.metric.type})`;
    case "chart":
      return `${block.title} (${block.config.chartType.replace("_", " ")}, ${block.config.groupBy === "none" ? "ungrouped" : `by ${block.config.groupBy}`})`;
    case "table":
      return `${block.title} (by ${block.query.groupBy}, ${block.query.binning})`;
    default:
      return ("title" in block && block.title) || block.kind;
  }
}

/** A KPI's figure. Mirrors client-core's `formatCostCanvasKpi`. */
export function formatKpi(kpi: CostCanvasKpiValue | null): string {
  if (!kpi || kpi.value === null) return "-";
  switch (kpi.unit) {
    case "money":
      return formatMoney(kpi.value, kpi.currency ?? "USD");
    case "money_per_unit":
      return `${formatMoney(kpi.value, kpi.currency ?? "USD")}${kpi.perUnit ? ` / ${kpi.perUnit}` : ""}`;
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

/** `infrawrench canvas list` */
export async function cmdCanvasList(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const canvases = await orgFetch<CostCanvas[]>(org.id, "/cost-canvases");
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, canvases });
    return;
  }
  println(`${c.bold(org.displayName)} ${c.dim("· canvases")}`);
  println();
  if (canvases.length === 0) {
    println(
      c.dim(
        "No canvases. Describe a report on the Canvases page (web or desktop) and the assistant builds it; refresh it here by name.",
      ),
    );
    return;
  }
  printTable(canvases, [
    { header: "name", value: (x) => c.bold(x.name) },
    { header: "blocks", value: (x) => String(x.spec.blocks.length) },
    {
      header: "dashboards",
      value: (x) =>
        x.placements.length === 0
          ? c.dim("—")
          : x.placements.map((p) => p.dashboardName).join(", "),
    },
    { header: "updated", value: (x) => c.dim(x.updatedAt.slice(0, 10)) },
  ]);
}

/** `infrawrench canvas show <name|id>`: the definition, not the numbers. */
export async function cmdCanvasShow(
  ctx: CliContext,
  query: string,
  pdf: PdfExportFlags,
): Promise<void> {
  requireCloud(ctx);
  const { org, canvas } = await findCanvas(ctx, query);
  if (wantsPdf(pdf, "canvas show")) {
    await exportPdf(ctx, {
      orgId: org.id,
      path: `/cost-canvases/${encodeURIComponent(canvas.id)}/pdf`,
      flags: pdf,
      subject: { kind: "canvas", id: canvas.id, name: canvas.name },
    });
    return;
  }
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, canvas });
    return;
  }
  println(`${c.bold(canvas.name)} ${c.dim(`· ${canvas.id}`)}`);
  if (canvas.description) println(c.dim(canvas.description));
  println();
  printKeyValues([
    ["prompt", canvas.prompt ?? c.dim("(written directly)")],
    ["blocks", String(canvas.spec.blocks.length)],
    [
      "dashboards",
      canvas.placements.length === 0
        ? c.dim("none")
        : canvas.placements.map((p) => p.dashboardName).join(", "),
    ],
    ["updated", canvas.updatedAt],
  ]);
  println();
  canvas.spec.blocks.forEach((b, i) => {
    println(
      `${c.dim(String(i + 1).padStart(2))}  ${c.cyan(b.kind.padEnd(12))} ${describeBlock(b)}`,
    );
  });
  println();
  println(c.dim(`Run it: infrawrench canvas refresh "${canvas.name}"`));
}

function printBlockResult(block: CostCanvasBlock, r: CostCanvasBlockResult): void {
  const title = block.kind === "text" ? "" : ("title" in block && block.title) || block.kind;
  if (r.error) {
    println(`${c.bold(title || "Text")}  ${c.red(r.error)}`);
    println();
    return;
  }
  switch (r.kind) {
    case "text":
      for (const line of r.text.split("\n")) {
        println(line.startsWith("#") ? c.bold(line.replace(/^#+\s*/, "")) : line);
      }
      break;
    case "kpi": {
      const change = formatChange(r.kpi?.changePercent);
      println(
        `${c.bold(title)}  ${formatKpi(r.kpi)}${change ? `  ${change} vs previous` : ""}${
          r.kpi?.from && r.kpi.to ? c.dim(`  (${r.kpi.from} → ${r.kpi.to})`) : ""
        }`,
      );
      if (r.kpi?.note) println(c.dim(`  ${r.kpi.note}`));
      break;
    }
    case "table": {
      println(c.bold(title));
      const t = r.table;
      if (!t || t.rows.length === 0) {
        println(c.dim("  no spend in this window"));
        break;
      }
      const currency = t.currency ?? "USD";
      const cols = t.columns.length > 6 ? t.columns.slice(-6) : t.columns;
      const offset = t.columns.length - cols.length;
      printTable(t.rows, [
        { header: "", value: (row) => row.label },
        ...(t.columns[0] === "total"
          ? []
          : cols.map((col, i) => ({
              header: col.slice(0, 7),
              value: (row: (typeof t.rows)[number]) =>
                formatMoney(row.values[i + offset] ?? 0, currency),
            }))),
        { header: "total", value: (row) => c.bold(formatMoney(row.total, currency)) },
      ]);
      break;
    }
    case "chart":
    case "cost_report": {
      const name = r.kind === "cost_report" ? (r.report?.name ?? title) : title;
      if (r.cost) {
        const currency = r.cost.currencies[0] ?? "USD";
        const buckets = new Map<string, number>();
        for (const s of r.cost.series.filter((x) => x.currency === currency)) {
          for (const p of s.points) buckets.set(p.bucket, (buckets.get(p.bucket) ?? 0) + p.amount);
        }
        const values = [...buckets.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, v]) => v);
        println(
          `${c.bold(name)}  ${formatMoney(r.cost.totals[currency] ?? 0, currency)}  ${c.cyan(sparkline(values, Math.min(40, values.length)))}${c.dim(`  (${r.from} → ${r.to})`)}`,
        );
      } else if (r.unitCost) {
        const u = r.unitCost;
        const s = u.series[0];
        const mode = u.mode as CliUnitCostMode;
        // Cost per usage unit has no metric: its unit is the usage unit.
        const unit =
          mode === "usage_unit_cost" ? (u.usageUnit ?? "unit") : (u.metric?.unit ?? "unit");
        const value =
          s && s.overallValue !== null
            ? `${formatUnitCostRatio(s.overallValue, mode)} ${unitCostRatioLabel(mode, s.currency, unit, u.scale)}`
            : "-";
        println(`${c.bold(name)}  ${value}${c.dim(`  (${r.from} → ${r.to})`)}`);
      } else {
        println(`${c.bold(name)}  ${c.dim("(chart)")}`);
      }
      break;
    }
    case "budgets":
      println(c.bold(title));
      for (const b of r.budgets) {
        const pct = b.amountCents > 0 ? Math.round((b.actualCents / b.amountCents) * 100) : 0;
        println(
          `  ${b.name}  ${formatMoney(b.actualCents / 100, b.currency)} of ${formatMoney(b.amountCents / 100, b.currency)} ${pct >= 100 ? c.red(`${pct}%`) : `${pct}%`}`,
        );
      }
      if (r.budgets.length === 0) println(c.dim("  no budgets"));
      break;
    case "anomalies":
      println(c.bold(title));
      if (r.withheld)
        println(c.dim("  withheld: anomalies are org-wide and your cost view is scoped"));
      else if (r.anomalies.length === 0) println(c.dim("  none in this window"));
      for (const a of r.anomalies) {
        println(
          `  ${a.day}  ${a.dimension}: ${a.dimensionKey}  ${formatMoney(a.actualCents / 100, a.currency)}`,
        );
      }
      break;
    case "custom_graph":
      println(
        `${c.bold(title || r.graph?.name || "Custom graph")}  ${c.dim(r.spec ? `(${r.spec.chart.type})` : "(no output)")}`,
      );
      break;
  }
  println();
}

/** `infrawrench canvas refresh <name|id>`: re-run every query and print the figures. */
export async function cmdCanvasRefresh(
  ctx: CliContext,
  query: string,
  pdf: PdfExportFlags,
): Promise<void> {
  requireCloud(ctx);
  const { org, canvas } = await findCanvas(ctx, query);
  if (wantsPdf(pdf, "canvas refresh")) {
    await exportPdf(ctx, {
      orgId: org.id,
      path: `/cost-canvases/${encodeURIComponent(canvas.id)}/pdf`,
      flags: pdf,
      subject: { kind: "canvas", id: canvas.id, name: canvas.name },
    });
    return;
  }
  const result = await orgFetch<CostCanvasRunResult>(
    org.id,
    `/cost-canvases/${encodeURIComponent(canvas.id)}/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeChartData: true }),
    },
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, canvas: { id: canvas.id, name: canvas.name }, result });
    return;
  }
  println(`${c.bold(canvas.name)} ${c.dim(`· refreshed ${result.ranAt}`)}`);
  println();
  const byId = new Map(result.blocks.map((b) => [b.id, b]));
  for (const block of canvas.spec.blocks) {
    const r = byId.get(block.id);
    if (r) printBlockResult(block, r);
  }
}
