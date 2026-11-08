// `infrawrench costs forecast <report>` and `costs forecasts <report>`: a saved
// report's projected spend with its low/expected/high band, and the report's
// named forecasts side by side.
//
// The numbers come from `POST /cost-reports/{id}/forecasted-costs`, the same
// read the report's Forecasts view draws, so the CLI never re-derives a fit.
// client-core imports are type-only: the CLI takes no runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  CostForecast,
  CostForecastConfidenceLevel,
  CostForecastResult,
  CostForecastRunRequest,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { from as fromFlag, to as toFlag } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, formatMoney, safe } from "../output";
import { lineChart } from "../charts";
import { resolveReport } from "./report-lookup";

const LEVELS: readonly CostForecastConfidenceLevel[] = [80, 90, 95];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const Forecast = wire<CostForecast>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    scenarioModelIds: Schema.Array(Schema.String),
    driverMetricId: Schema.NullOr(Schema.String),
    isDefault: Schema.Boolean,
  }),
);
type Forecast = typeof Forecast.Type;
const Forecasts = Schema.Struct({ forecasts: Schema.Array(Forecast) });

const Total = Schema.Struct({
  expected: Schema.Finite,
  low: Schema.NullOr(Schema.Finite),
  high: Schema.NullOr(Schema.Finite),
});
type Total = typeof Total.Type;

const Series = Schema.Struct({
  forecastId: Schema.NullOr(Schema.String),
  name: Schema.String,
  isDefault: Schema.Boolean,
  points: Schema.Array(Schema.Struct({ expected: Schema.Finite })),
  total: Total,
  deltaFromBaseline: Schema.Finite,
  scenarios: Schema.Array(Schema.Struct({ modelName: Schema.String, totalDelta: Schema.Finite })),
  driver: Schema.NullOr(
    Schema.Struct({
      metricName: Schema.String,
      metricUnit: Schema.String,
      unitCost: Schema.NullOr(Schema.Finite),
      metricTotal: Schema.Finite,
      coveredDays: Schema.Finite,
      totalDays: Schema.Finite,
    }),
  ),
  warnings: Schema.Array(Schema.String),
});
type Series = typeof Series.Type;

const Result = wire<CostForecastResult>()(
  Schema.Struct({
    reportName: Schema.String,
    from: Schema.String,
    to: Schema.String,
    lastObservedDay: Schema.NullOr(Schema.String),
    currency: Schema.NullOr(Schema.String),
    confidenceLevel: Schema.Finite,
    baseline: Series,
    forecast: Series,
    forecasts: Schema.optional(Schema.Array(Series)),
  }),
);
type Result = typeof Result.Type;

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "Forecasts are computed in Infrawrench Cloud; there is no local cost history.",
    });
  }
});

function parseLevel(
  raw: Option.Option<string>,
): CostForecastConfidenceLevel | undefined | CliUsageError {
  if (Option.isNone(raw)) return undefined;
  const n = Number(raw.value.replace(/%$/, ""));
  const level = LEVELS.find((l) => l === n);
  if (level === undefined) {
    return new CliUsageError({ message: `--level must be 80, 90 or 95 (got "${raw.value}").` });
  }
  return level;
}

/**
 * `--forecast` names a forecast by id or (case-insensitively) by name;
 * `auto` / `baseline` / `trend` asks for the automatic forecast.
 */
function resolveForecastFlag(
  forecasts: ReadonlyArray<Forecast>,
  raw: Option.Option<string>,
): string | undefined | CliFailure {
  if (Option.isNone(raw)) return undefined;
  const q = raw.value.trim();
  if (["auto", "automatic", "baseline", "trend"].includes(q.toLowerCase())) return "baseline";
  const byId = forecasts.find((f) => f.id === q);
  if (byId) return byId.id;
  const byName = forecasts.filter((f) => f.name.toLowerCase() === q.toLowerCase());
  const [oneByName] = byName;
  if (oneByName && byName.length === 1) return oneByName.id;
  const partial = forecasts.filter((f) => f.name.toLowerCase().includes(q.toLowerCase()));
  const [onePartial] = partial;
  if (onePartial && partial.length === 1) return onePartial.id;
  return new CliFailure({
    message:
      partial.length === 0
        ? `No forecast on this report matches "${raw.value}". Run \`infrawrench costs forecasts <report>\` to list them.`
        : `"${raw.value}" matches ${partial.length} forecasts: ${partial.map((f) => f.name).join(", ")}.`,
  });
}

function money(n: number, currency: string | null): string {
  return currency ? formatMoney(n, currency) : n.toFixed(2);
}

function rangeText(t: Total, currency: string | null): string {
  return t.low !== null && t.high !== null
    ? `${money(t.low, currency)} to ${money(t.high, currency)}`
    : "–";
}

function signed(n: number, currency: string | null): string {
  return `${n >= 0 ? "+" : "-"}${money(Math.abs(n), currency)}`;
}

/** A comma-separated list flag, trimmed, empties dropped. */
const listOf = (raw: Option.Option<string>): string[] =>
  Option.getOrElse(raw, () => "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const report = Argument.String("report").pipe(
  Argument.withDescription("The saved report, by name or id (the words join into one name)"),
  Argument.variadic(),
);

const forecastsPath = (reportId: string) =>
  `/cost-reports/${encodeURIComponent(reportId)}/forecasts`;

/** `costs forecasts <report>`: the report's named forecasts. */
export const costForecasts = Command.make(
  "forecasts",
  { report },
  Effect.fn("costs.forecasts")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const query = input.report.join(" ");
    if (!query) {
      return yield* new CliUsageError({
        message: "Name a report: `infrawrench costs forecasts <report name|id>`.",
      });
    }
    const org = yield* currentOrg;
    const { row: found } = yield* resolveReport(org.id, query);
    const path = forecastsPath(found.id);
    const body = yield* api.decode(Schema.Struct({ forecasts: Schema.Unknown }), org.id, path);
    if (session.output === "json") {
      return yield* Print.json({
        org: org.id,
        reportId: found.id,
        report: found.name,
        forecasts: body.forecasts,
      });
    }
    const forecasts = yield* decodeBody(Schema.Array(Forecast), path)(body.forecasts);
    yield* Print.line(`${c.bold(safe(found.name))} ${c.dim("· named forecasts")}`);
    yield* Print.table(forecasts, [
      {
        header: "Name",
        value: (f) => (f.isDefault ? `${safe(f.name)} ${c.dim("(default)")}` : safe(f.name)),
      },
      {
        header: "Baseline",
        value: (f) => (f.driverMetricId ? `driver ${safe(f.driverMetricId)}` : "trend"),
      },
      { header: "Scenarios", value: (f) => String(f.scenarioModelIds.length) },
      { header: "Id", value: (f) => c.dim(safe(f.id)) },
    ]);
    if (forecasts.length === 0) {
      yield* Print.line(
        c.dim(
          "Only the automatic forecast. Add named ones from the report's Forecasts section in the app.",
        ),
      );
    }
  }),
).pipe(Command.withDescription("A report's named forecasts, the default marked"));

/** `costs forecast <report>`: projected spend with its band. */
export const costForecast = Command.make(
  "forecast",
  {
    report,
    from: fromFlag.pipe(Flag.withDescription("Start of the projected window, YYYY-MM-DD")),
    to: toFlag.pipe(
      Flag.withDescription("End of the projected window, YYYY-MM-DD (default: 90 days)"),
    ),
    forecast: Flag.String("forecast").pipe(
      Flag.withMetavar("name|id|auto"),
      Flag.withDescription("Which named forecast (default: the report's default one)"),
      Flag.optional,
    ),
    provider: Flag.String("provider").pipe(
      Flag.withMetavar("aws,gcp"),
      Flag.withDescription("Only these providers"),
      Flag.optional,
    ),
    service: Flag.String("service").pipe(
      Flag.withMetavar("name,..."),
      Flag.withDescription("Only these services"),
      Flag.optional,
    ),
    level: Flag.String("level").pipe(
      Flag.withMetavar("80|90|95"),
      Flag.withDescription("The band level, in percent"),
      Flag.optional,
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Every named forecast side by side"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("costs.forecast")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const query = input.report.join(" ");
    if (!query) {
      return yield* new CliUsageError({
        message:
          "Name a report: `infrawrench costs forecast <report name|id> [--forecast <name>] [--to YYYY-MM-DD]`.",
      });
    }
    for (const [flag, value] of [
      ["--from", input.from],
      ["--to", input.to],
    ] as const) {
      if (Option.isSome(value) && !ISO_DAY.test(value.value)) {
        return yield* new CliUsageError({
          message: `${flag} must be a day, YYYY-MM-DD (got "${value.value}").`,
        });
      }
    }
    const org = yield* currentOrg;
    const { row: found } = yield* resolveReport(org.id, query);
    const { forecasts } = yield* api.decode(Forecasts, org.id, forecastsPath(found.id));
    const level = parseLevel(input.level);
    if (level instanceof CliUsageError) return yield* level;
    const forecastId = resolveForecastFlag(forecasts, input.forecast);
    if (forecastId instanceof CliFailure) return yield* forecastId;
    const providers = listOf(input.provider);
    const services = listOf(input.service);
    const from = Option.getOrUndefined(input.from);
    const to = Option.getOrUndefined(input.to);
    const request: CostForecastRunRequest = {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(forecastId ? { forecastId } : {}),
      ...(providers.length > 0 ? { providers } : {}),
      ...(services.length > 0 ? { services } : {}),
      ...(level ? { confidenceLevel: level } : {}),
      ...(input.all ? { all: true } : {}),
    };
    const path = `/cost-reports/${encodeURIComponent(found.id)}/forecasted-costs`;
    const body = yield* api.json(org.id, path, { method: "POST", body: JSON.stringify(request) });

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id, request }, body, path));
    }
    yield* printForecast(yield* decodeBody(Result, path)(body), input.all);
  }),
).pipe(
  Command.withDescription(
    "A saved report's projected spend with its low/expected/high band (default: next 90 days)",
  ),
);

const printForecast = Effect.fnUntraced(function* (result: Result, all: boolean) {
  const cur = result.currency;
  const selected = result.forecast;
  yield* Print.line(
    `${c.bold(safe(result.reportName))} ${c.dim(`· ${safe(result.from)} → ${safe(result.to)}`)}  ${c.bold(
      money(selected.total.expected, cur),
    )} ${c.dim(`(${result.confidenceLevel}%: ${rangeText(selected.total, cur)})`)}`,
  );
  yield* Print.line(
    c.dim(
      result.lastObservedDay
        ? `${selected.forecastId ? `Forecast "${safe(selected.name)}"` : "Automatic forecast"}, projected from spend through ${safe(result.lastObservedDay)}.`
        : "No spend collected for this report's scope yet.",
    ),
  );
  for (const w of selected.warnings) yield* Print.line(c.yellow(`! ${safe(w)}`));
  yield* Print.line();

  if (selected.points.length > 0) {
    for (const row of lineChart(
      selected.points.map((p) => p.expected),
      { width: 60, height: 6, colorIndex: 0 },
    )) {
      yield* Print.line(row);
    }
    yield* Print.line();
  }

  if (selected.driver) {
    const d = selected.driver;
    const unit = safe(d.metricUnit);
    yield* Print.line(
      c.dim(
        `Driven by ${safe(d.metricName)}: ${d.unitCost !== null ? `${money(d.unitCost, cur)} per ${unit}` : "no unit cost"} × ${d.metricTotal} ${unit} planned (${d.coveredDays}/${d.totalDays} days).`,
      ),
    );
  }
  for (const s of selected.scenarios) {
    yield* Print.line(c.dim(`Scenario ${safe(s.modelName)}: ${signed(s.totalDelta, cur)}`));
  }

  const rows: Series[] = [
    result.baseline,
    ...(all ? (result.forecasts ?? []) : selected.forecastId ? [selected] : []),
  ];
  if (rows.length > 1) {
    yield* Print.line();
    yield* Print.table(rows, [
      {
        header: "Forecast",
        value: (s) =>
          s.forecastId === null
            ? "Automatic (trend)"
            : s.isDefault
              ? `${safe(s.name)} ${c.dim("(default)")}`
              : safe(s.name),
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
});
