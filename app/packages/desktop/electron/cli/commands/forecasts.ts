// `infrawrench costs forecast <report>` and `costs forecasts <report>`: a saved
// report's projected spend with its low/expected/high band, and the report's
// named forecasts side by side.
//
// The numbers come from `POST /cost-reports/{id}/forecasted-costs`, the same
// read the report's Forecasts view draws, so the CLI never re-derives a fit.
// client-core imports are type-only: the CLI takes no runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  CostForecast,
  CostForecastResult,
  CostForecastRunRequest,
  CostForecastSeries,
  CostForecastTotal,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, formatMoney, printJson, println, printTable } from "../output";
import { lineChart } from "../charts";
import type { ParsedCli, RangeFlags } from "../args";
import { resolveReport } from "./reports";

type ForecastFlags = ParsedCli["forecast"];

const LEVELS = new Set([80, 90, 95]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Forecasts are computed in Infrawrench Cloud; there is no local cost history.",
    );
  }
}

function parseLevel(raw: string | undefined): 80 | 90 | 95 | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/%$/, ""));
  if (!LEVELS.has(n)) throw new CliError(`--level must be 80, 90 or 95 (got "${raw}").`, 2);
  return n as 80 | 90 | 95;
}

/**
 * `--forecast` names a forecast by id or (case-insensitively) by name;
 * `auto` / `baseline` / `trend` asks for the automatic forecast.
 */
function resolveForecastFlag(
  forecasts: CostForecast[],
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const q = raw.trim();
  if (["auto", "automatic", "baseline", "trend"].includes(q.toLowerCase())) return "baseline";
  const byId = forecasts.find((f) => f.id === q);
  if (byId) return byId.id;
  const byName = forecasts.filter((f) => f.name.toLowerCase() === q.toLowerCase());
  if (byName.length === 1) return byName[0]!.id;
  const partial = forecasts.filter((f) => f.name.toLowerCase().includes(q.toLowerCase()));
  if (partial.length === 1) return partial[0]!.id;
  if (partial.length === 0) {
    throw new CliError(
      `No forecast on this report matches "${raw}". Run \`infrawrench costs forecasts <report>\` to list them.`,
    );
  }
  throw new CliError(
    `"${raw}" matches ${partial.length} forecasts: ${partial.map((f) => f.name).join(", ")}.`,
  );
}

function money(n: number, currency: string | null): string {
  return currency ? formatMoney(n, currency) : n.toFixed(2);
}

function rangeText(t: CostForecastTotal, currency: string | null): string {
  return t.low !== null && t.high !== null
    ? `${money(t.low, currency)} to ${money(t.high, currency)}`
    : "–";
}

function signed(n: number, currency: string | null): string {
  return `${n >= 0 ? "+" : "-"}${money(Math.abs(n), currency)}`;
}

/** `costs forecasts <report>`: the report's named forecasts. */
export async function cmdCostForecasts(
  ctx: CliContext,
  reportQuery: string | undefined,
): Promise<void> {
  requireCloud(ctx);
  if (!reportQuery) {
    throw new CliError("Name a report: `infrawrench costs forecasts <report name|id>`.", 2);
  }
  const org = await resolveOrg(ctx);
  const report = await resolveReport(org.id, reportQuery);
  const res = await orgFetch<{ forecasts: CostForecast[] }>(
    org.id,
    `/cost-reports/${encodeURIComponent(report.id)}/forecasts`,
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, reportId: report.id, report: report.name, forecasts: res.forecasts });
    return;
  }
  println(`${c.bold(report.name)} ${c.dim("· named forecasts")}`);
  printTable(res.forecasts, [
    { header: "Name", value: (f) => (f.isDefault ? `${f.name} ${c.dim("(default)")}` : f.name) },
    {
      header: "Baseline",
      value: (f) => (f.driverMetricId ? `driver ${f.driverMetricId}` : "trend"),
    },
    { header: "Scenarios", value: (f) => String(f.scenarioModelIds.length) },
    { header: "Id", value: (f) => c.dim(f.id) },
  ]);
  if (res.forecasts.length === 0) {
    println(
      c.dim(
        "Only the automatic forecast. Add named ones from the report's Forecasts section in the app.",
      ),
    );
  }
}

/** `costs forecast <report>`: projected spend with its band. */
export async function cmdCostForecast(
  ctx: CliContext,
  reportQuery: string | undefined,
  range: RangeFlags,
  flags: ForecastFlags,
): Promise<void> {
  requireCloud(ctx);
  if (!reportQuery) {
    throw new CliError(
      "Name a report: `infrawrench costs forecast <report name|id> [--forecast <name>] [--to YYYY-MM-DD]`.",
      2,
    );
  }
  for (const [flag, value] of [
    ["--from", range.from],
    ["--to", range.to],
  ] as const) {
    if (value !== undefined && !ISO_DAY.test(value)) {
      throw new CliError(`${flag} must be a day, YYYY-MM-DD (got "${value}").`, 2);
    }
  }
  const org = await resolveOrg(ctx);
  const report = await resolveReport(org.id, reportQuery);
  const { forecasts } = await orgFetch<{ forecasts: CostForecast[] }>(
    org.id,
    `/cost-reports/${encodeURIComponent(report.id)}/forecasts`,
  );
  const level = parseLevel(flags.level);
  const forecastId = resolveForecastFlag(forecasts, flags.name);
  const request: CostForecastRunRequest = {
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    ...(forecastId ? { forecastId } : {}),
    ...(flags.providers.length > 0 ? { providers: flags.providers } : {}),
    ...(flags.services.length > 0 ? { services: flags.services } : {}),
    ...(level ? { confidenceLevel: level } : {}),
    ...(flags.all ? { all: true } : {}),
  };
  const result = await orgFetch<CostForecastResult>(
    org.id,
    `/cost-reports/${encodeURIComponent(report.id)}/forecasted-costs`,
    { method: "POST", body: JSON.stringify(request) },
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, request, ...result });
    return;
  }
  printForecast(result, flags.all);
}

function printForecast(result: CostForecastResult, all: boolean): void {
  const cur = result.currency;
  const selected = result.forecast;
  println(
    `${c.bold(result.reportName)} ${c.dim(`· ${result.from} → ${result.to}`)}  ${c.bold(
      money(selected.total.expected, cur),
    )} ${c.dim(`(${result.confidenceLevel}%: ${rangeText(selected.total, cur)})`)}`,
  );
  println(
    c.dim(
      result.lastObservedDay
        ? `${selected.forecastId ? `Forecast "${selected.name}"` : "Automatic forecast"}, projected from spend through ${result.lastObservedDay}.`
        : "No spend collected for this report's scope yet.",
    ),
  );
  for (const w of selected.warnings) println(c.yellow(`! ${w}`));
  println();

  if (selected.points.length > 0) {
    for (const line of lineChart(
      selected.points.map((p) => p.expected),
      { width: 60, height: 6, colorIndex: 0 },
    )) {
      println(line);
    }
    println();
  }

  if (selected.driver) {
    const d = selected.driver;
    println(
      c.dim(
        `Driven by ${d.metricName}: ${d.unitCost !== null ? `${money(d.unitCost, cur)} per ${d.metricUnit}` : "no unit cost"} × ${d.metricTotal} ${d.metricUnit} planned (${d.coveredDays}/${d.totalDays} days).`,
      ),
    );
  }
  for (const s of selected.scenarios) {
    println(c.dim(`Scenario ${s.modelName}: ${signed(s.totalDelta, cur)}`));
  }

  const rows: CostForecastSeries[] = [
    result.baseline,
    ...(all ? (result.forecasts ?? []) : selected.forecastId ? [selected] : []),
  ];
  if (rows.length > 1) {
    println();
    printTable(rows, [
      {
        header: "Forecast",
        value: (s) =>
          s.forecastId === null
            ? "Automatic (trend)"
            : s.isDefault
              ? `${s.name} ${c.dim("(default)")}`
              : s.name,
      },
      { header: "Expected", value: (s) => money(s.total.expected, cur), align: "right" },
      {
        header: `${result.confidenceLevel}% range`,
        value: (s) => rangeText(s.total, cur),
        align: "right",
      },
      {
        header: "vs automatic",
        value: (s) => (s.forecastId === null ? "–" : signed(s.deltaFromBaseline, cur)),
        align: "right",
      },
    ]);
  }
}
