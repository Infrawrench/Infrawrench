// `infrawrench scenarios`: the org's scenario models, and applying one to a
// forecast.
//
// A forecast is a least-squares fit over trailing daily totals: it can only
// extrapolate what already happened. A scenario model is where the org writes
// down what it already *knows* is coming: a purchase next quarter, a team
// starting in September, a migration that takes a fifth off compute.
//
// Bare `scenarios` lists the models; `scenarios <name|id>` applies one and
// prints **both** projections, because the point of the feature is that the
// trend stays visible underneath the assumptions.
//
// Reads over the same endpoints the web/desktop Costs panel uses; the wire
// shapes come from `@infrawrench/client-core` type-only, so the CLI keeps its
// zero-runtime-dependency rule.
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  CostQueryRequest,
  CostQueryResponse,
  CostScenarioModel,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { dateRange, resolveDateRange } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, formatMoney, safe } from "../output";
import { lineChart, resample, timeAxis } from "../charts";

/** How a scope term's operator reads in the table (client-core is type-only here). */
const SCOPE_OP: Partial<Record<string, string>> = {
  in: " ∈ ",
  not_in: " ∌ ",
  flexible_match: " ~ ",
  contains: " contains ",
  not_contains: " lacks ",
  starts_with: " starts ",
  is_set: " is set",
  is_not_set: " is not set",
};

const Adjustment = Schema.Struct({
  label: Schema.String,
  kind: Schema.String,
  startDate: Schema.String,
  endDate: Schema.NullOr(Schema.String),
  amountCents: Schema.NullOr(Schema.Finite),
  currency: Schema.NullOr(Schema.String),
  period: Schema.NullOr(Schema.String),
  percent: Schema.NullOr(Schema.Finite),
  scope: Schema.Array(
    Schema.Struct({
      dimension: Schema.String,
      op: Schema.String,
      values: Schema.Array(Schema.String),
    }),
  ),
});
type Adjustment = typeof Adjustment.Type;

const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  currency: Schema.String,
  adjustments: Schema.Array(Adjustment),
});

// A 204, or a body without `models`, lists nothing.
const Models = Schema.UndefinedOr(
  wire<{ models: CostScenarioModel[] }>()(
    Schema.Struct({ models: Schema.optional(Schema.Array(Model)) }),
  ),
);
const RawModels = Schema.UndefinedOr(
  Schema.Struct({ models: Schema.optional(Schema.Array(Schema.Unknown)) }),
);

const Point = Schema.Struct({ bucket: Schema.String, amount: Schema.Finite });

const Projection = wire<CostQueryResponse>()(
  Schema.Struct({
    currencies: Schema.Array(Schema.String),
    forecast: Schema.optional(Schema.Array(Point)),
    scenario: Schema.optional(
      Schema.Struct({
        points: Schema.Array(Point),
        contributions: Schema.Array(
          Schema.Struct({ label: Schema.String, kind: Schema.String, amount: Schema.Finite }),
        ),
        convertedFrom: Schema.optional(Schema.String),
        outOfScope: Schema.Array(Schema.String),
      }),
    ),
  }),
);

const MODELS_PATH = "/cost-scenarios";

/** "+$40,000 on 2026-09-12", "-20% from 2026-10-01 until 2026-12-31". */
function describeAdjustment(adjustment: Adjustment, currency: string): string {
  const until = adjustment.endDate ? ` until ${adjustment.endDate}` : "";
  if (adjustment.kind === "rate_change") {
    const pct = adjustment.percent ?? 0;
    return `${pct > 0 ? "+" : ""}${pct}% from ${adjustment.startDate}${until}`;
  }
  const amount = (adjustment.amountCents ?? 0) / 100;
  const money = formatMoney(amount, adjustment.currency ?? currency);
  if (adjustment.kind === "one_off") {
    return `${amount > 0 ? "+" : ""}${money} on ${adjustment.startDate}`;
  }
  const per = adjustment.period === "daily" ? "per day" : "per month";
  return `${amount > 0 ? "+" : ""}${money} ${per} from ${adjustment.startDate}${until}`;
}

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "Scenario models are org-level cloud state. There is no local forecast to adjust.",
    });
  }
});

/** List the org's scenario models and what each one assumes. */
const listModels = Effect.fn("scenarios")(function* (orgId: string, orgName: string) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const body = yield* api.json(orgId, MODELS_PATH);

  if (session.output === "json") {
    const raw = yield* decodeBody(RawModels, MODELS_PATH)(body);
    return yield* Print.json({ org: orgId, models: raw?.models ?? [] });
  }
  const models = (yield* decodeBody(Models, MODELS_PATH)(body))?.models ?? [];

  if (models.length === 0) {
    return yield* Print.line(
      c.dim(
        "No scenario models. A scenario is known future cost the trend can't see, such as a purchase " +
          "or migration. Create one on the Costs panel.",
      ),
    );
  }

  yield* Print.line(`${c.bold(safe(orgName))} ${c.dim(`· ${models.length} scenario models`)}`);
  yield* Print.line();
  for (const model of models) {
    yield* Print.line(`${c.bold(safe(model.name))} ${c.dim(`· ${model.currency}`)}`);
    if (model.description) yield* Print.line(c.dim(`  ${safe(model.description)}`));
    yield* Print.table(model.adjustments, [
      { header: "adjustment", value: (a) => `  ${safe(a.label)}` },
      { header: "effect", value: (a) => describeAdjustment(a, model.currency) },
      {
        header: "scope",
        value: (a) =>
          a.scope.length === 0
            ? c.dim("whole org")
            : safe(
                a.scope
                  .map((f) => `${f.dimension}${SCOPE_OP[f.op] ?? f.op}${f.values.join("|")}`)
                  .join(", "),
              ),
      },
    ]);
    yield* Print.line();
  }
  yield* Print.line(
    c.dim("Apply one with `infrawrench scenarios <name>`. The trend is always shown alongside."),
  );
});

/**
 * Apply a scenario to the org's forecast and print both projections.
 *
 * Both, always. A single adjusted number under the word "forecast" would be a
 * hypothesis wearing a measurement's clothes; the whole reason a scenario is a
 * separate object is that a reader can see what the trend said before it was
 * touched.
 */
const applyModel = Effect.fn("scenarios.apply")(function* (
  orgId: string,
  orgName: string,
  wanted: string,
  range: { from: string; to: string },
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const models =
    (yield* decodeBody(Models, MODELS_PATH)(yield* api.json(orgId, MODELS_PATH)))?.models ?? [];

  // Matched by id first, then case-insensitively by name; names are unique per
  // org, so a name can never be ambiguous. An unknown value is an error listing
  // what exists, never a silent fall-through to an unadjusted projection, which
  // would answer a different question under the heading the user asked for.
  const model =
    models.find((m) => m.id === wanted) ??
    models.find((m) => m.name.toLowerCase() === wanted.toLowerCase());
  if (!model) {
    const names = models.map((m) => `"${m.name}"`).join(", ");
    return yield* new CliUsageError({
      message:
        `No scenario model named "${wanted}".` +
        (models.length > 0
          ? ` Scenario models: ${names}.`
          : " This organization has no scenario models yet. Create one on the Costs panel."),
    });
  }

  const { from, to } = range;
  const query: CostQueryRequest = {
    from,
    to,
    binning: "daily",
    groupBy: "none",
    filters: [],
    topN: 1,
    comparePreviousPeriod: false,
    // Both required together: the scenario adjusts the projected region, and
    // the server refuses the pair rather than silently returning no scenario.
    forecast: true,
    scenarioModelId: model.id,
  };
  const path = "/costs/query";
  const body = yield* api.json(orgId, path, { method: "POST", body: JSON.stringify(query) });

  if (session.output === "json") {
    // `forecast` (the untouched trend) and `scenario` (the adjusted
    // projection) both ride along in the response: a script must be able to
    // diff them without re-running the query.
    return yield* Print.json(
      yield* spreadBody(
        {
          org: orgId,
          from,
          to,
          scenario: { id: model.id, name: model.name, currency: model.currency },
        },
        body,
        path,
      ),
    );
  }
  const response = yield* decodeBody(Projection, path)(body);

  const currency = response.currencies[0] ?? "USD";
  const trend = response.forecast ?? [];
  const adjusted = response.scenario?.points ?? [];
  const first = trend[0];
  const last = trend[trend.length - 1];

  if (!first || !last) {
    return yield* Print.line(
      c.dim("No forecast for this range. A trend fit needs at least 7 days of collected spend."),
    );
  }

  const trendTotal = trend.reduce((sum, p) => sum + p.amount, 0);
  const adjustedTotal = adjusted.reduce((sum, p) => sum + p.amount, 0);
  const delta = adjustedTotal - trendTotal;

  yield* Print.line(
    `${c.bold(safe(orgName))} ${c.dim(`· scenario "${safe(model.name)}" · ${first.bucket} → ${last.bucket}`)}`,
  );
  yield* Print.line();
  yield* Print.line(
    `${c.dim("trend".padEnd(12))}${c.bold(formatMoney(trendTotal, currency))} ${c.dim("over the horizon")}`,
  );
  yield* Print.line(
    `${c.dim("scenario".padEnd(12))}${c.bold(formatMoney(adjustedTotal, currency))} ` +
      (delta >= 0
        ? c.red(`+${formatMoney(delta, currency)}`)
        : c.green(formatMoney(delta, currency))),
  );
  yield* Print.line();

  // Two lines on one plot, the same shape the chart draws: the assumptions are
  // never presented on their own.
  const width = 48;
  const chart = lineChart(
    resample(
      adjusted.map((p) => p.amount),
      width,
    ),
    { height: 8, width },
  );
  for (const line of chart) yield* Print.line(`  ${c.yellow(line)}`);
  yield* Print.line(`  ${timeAxis(Date.parse(first.bucket), Date.parse(last.bucket), width, 2)}`);
  yield* Print.line(c.dim("  (scenario-adjusted projection; the trend total is printed above it)"));
  yield* Print.line();

  const contributions = response.scenario?.contributions ?? [];
  if (contributions.length > 0) {
    yield* Print.table(contributions, [
      { header: "adjustment", value: (r) => safe(r.label) },
      { header: "kind", value: (r) => c.dim(safe(r.kind.replace("_", " "))) },
      {
        header: "over horizon",
        value: (r) =>
          r.amount === 0
            ? c.dim("—")
            : r.amount > 0
              ? c.red(`+${formatMoney(r.amount, currency)}`)
              : c.green(formatMoney(r.amount, currency)),
        align: "right",
      },
    ]);
  }

  const outOfScope = response.scenario?.outOfScope ?? [];
  if (outOfScope.length > 0) {
    yield* Print.line();
    yield* Print.line(
      c.dim(`Not applied (outside this query's scope): ${safe(outOfScope.join(", "))}.`),
    );
  }
  if (response.scenario?.convertedFrom) {
    yield* Print.line(
      c.dim(
        `Amounts converted from ${response.scenario.convertedFrom} at the organization's stated rates.`,
      ),
    );
  }
  yield* Print.line();
  yield* Print.line(
    c.dim(
      "A scenario never changes recorded spend, and it does not change any budget's alerting " +
        "unless that budget separately opted into this model.",
    ),
  );
});

export const scenarios = Command.make(
  "scenarios",
  {
    model: Argument.String("name|id").pipe(
      Argument.withDescription("A model to apply to the forecast (the words join into one name)"),
      Argument.variadic(),
    ),
    ...dateRange,
  },
  Effect.fn("scenarios")(function* (input) {
    yield* requireCloud;
    const org = yield* currentOrg;
    const wanted = input.model.join(" ");
    if (wanted.length === 0) return yield* listModels(org.id, org.displayName);
    return yield* applyModel(org.id, org.displayName, wanted, resolveDateRange(input));
  }),
).pipe(
  Command.withDescription(
    "Scenario models: known future cost the trend can't see; give a name to apply one",
  ),
);
