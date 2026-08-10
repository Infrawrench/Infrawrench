// `infrawrench scenarios` — the org's scenario models, and applying one to a
// forecast.
//
// A forecast is a least-squares fit over trailing daily totals: it can only
// extrapolate what already happened. A scenario model is where the org writes
// down what it already *knows* is coming — a purchase next quarter, a team
// starting in September, a migration that takes a fifth off compute.
//
// Bare `scenarios` lists the models; `scenarios <name|id>` applies one and
// prints **both** projections, because the point of the feature is that the
// trend stays visible underneath the assumptions.
//
// Reads over the same endpoints the web/desktop Costs panel uses; the wire
// shapes come from `@infrawrench/client-core` type-only, so the CLI keeps its
// zero-runtime-dependency rule.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  CostQueryRequest,
  CostQueryResponse,
  CostScenarioAdjustment,
  CostScenarioModel,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags } from "../args";
import { parseLastDays } from "../args";
import { c, printJson, println, printTable, formatMoney } from "../output";
import { lineChart, resample, timeAxis } from "../charts";

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "+$40,000 on 2026-09-12", "-20% from 2026-10-01 until 2026-12-31". */
function describeAdjustment(adjustment: CostScenarioAdjustment, currency: string): string {
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

async function loadModels(orgId: string): Promise<CostScenarioModel[]> {
  const res = await orgFetch<{ models: CostScenarioModel[] }>(orgId, "/cost-scenarios");
  return res?.models ?? [];
}

/**
 * `<name|id>` → the model it names.
 *
 * Matched by id first, then case-insensitively by name; names are unique per
 * org, so a name can never be ambiguous. An unknown value is an error listing
 * what exists — never a silent fall-through to an unadjusted projection, which
 * would answer a different question under the heading the user asked for.
 */
function resolveModel(models: CostScenarioModel[], wanted: string): CostScenarioModel {
  const match =
    models.find((m) => m.id === wanted) ??
    models.find((m) => m.name.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    const names = models.map((m) => `"${m.name}"`).join(", ");
    throw new CliError(
      `No scenario model named "${wanted}".` +
        (models.length > 0
          ? ` Scenario models: ${names}.`
          : " This organization has no scenario models yet — create one on the Costs panel."),
      2,
    );
  }
  return match;
}

/** List the org's scenario models and what each one assumes. */
export async function cmdScenarios(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Scenario models are org-level cloud state — there is no local forecast to adjust.",
    );
  }
  const org = await resolveOrg(ctx);
  const models = await loadModels(org.id);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, models });
    return;
  }

  if (models.length === 0) {
    println(
      c.dim(
        "No scenario models. A scenario is known future cost the trend can't see — a purchase, " +
          "a new team, a migration. Create one on the Costs panel.",
      ),
    );
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim(`· ${models.length} scenario models`)}`);
  println();
  for (const model of models) {
    println(`${c.bold(model.name)} ${c.dim(`· ${model.currency}`)}`);
    if (model.description) println(c.dim(`  ${model.description}`));
    printTable(model.adjustments, [
      { header: "adjustment", value: (a) => `  ${a.label}` },
      { header: "effect", value: (a) => describeAdjustment(a, model.currency) },
      {
        header: "scope",
        value: (a) =>
          a.scope.length === 0
            ? c.dim("whole org")
            : a.scope
                .map(
                  (f) => `${f.dimension}${f.op === "not_in" ? " ∌ " : " ∈ "}${f.values.join("|")}`,
                )
                .join(", "),
      },
    ]);
    println();
  }
  println(
    c.dim("Apply one with `infrawrench scenarios <name>` — the trend is always shown alongside."),
  );
}

/**
 * Apply a scenario to the org's forecast and print both projections.
 *
 * Both, always. A single adjusted number under the word "forecast" would be a
 * hypothesis wearing a measurement's clothes; the whole reason a scenario is a
 * separate object is that a reader can see what the trend said before it was
 * touched.
 */
export async function cmdApplyScenario(
  ctx: CliContext,
  wanted: string,
  range: RangeFlags,
): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Scenario models are org-level cloud state — there is no local forecast to adjust.",
    );
  }
  const org = await resolveOrg(ctx);
  const model = resolveModel(await loadModels(org.id), wanted);

  const days = range.last ? Math.max(1, Math.round(parseLastDays(range.last))) : 30;
  const to = range.to ?? isoDay(Date.now());
  const from = range.from ?? isoDay(Date.parse(to) - (days - 1) * 86_400_000);

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

  const response = await orgFetch<CostQueryResponse>(org.id, "/costs/query", {
    method: "POST",
    body: JSON.stringify(query),
  });

  if (ctx.flags.output === "json") {
    printJson({
      org: org.id,
      from,
      to,
      scenario: { id: model.id, name: model.name, currency: model.currency },
      // `forecast` (the untouched trend) and `scenario` (the adjusted
      // projection) both ride along in `response` — a script must be able to
      // diff them without re-running the query.
      ...response,
    });
    return;
  }

  const currency = response.currencies[0] ?? "USD";
  const trend = response.forecast ?? [];
  const adjusted = response.scenario?.points ?? [];

  if (trend.length === 0) {
    println(
      c.dim(
        "No forecast for this range — a trend fit needs at least 7 days of collected spend, " +
          "and a scenario adjusts a projection rather than replacing one.",
      ),
    );
    return;
  }

  const trendTotal = trend.reduce((sum, p) => sum + p.amount, 0);
  const adjustedTotal = adjusted.reduce((sum, p) => sum + p.amount, 0);
  const delta = adjustedTotal - trendTotal;

  println(
    `${c.bold(org.displayName)} ${c.dim(`· scenario "${model.name}" · ${trend[0]!.bucket} → ${trend[trend.length - 1]!.bucket}`)}`,
  );
  println();
  println(
    `${c.dim("trend".padEnd(12))}${c.bold(formatMoney(trendTotal, currency))} ${c.dim("over the horizon")}`,
  );
  println(
    `${c.dim("scenario".padEnd(12))}${c.bold(formatMoney(adjustedTotal, currency))} ` +
      (delta >= 0
        ? c.red(`+${formatMoney(delta, currency)}`)
        : c.green(formatMoney(delta, currency))),
  );
  println();

  // Two lines on one plot, the same shape the chart draws: the assumptions are
  // never presented on their own.
  const width = 48;
  const chart = lineChart(
    resample(
      adjusted.map((p) => p.amount),
      width,
    ),
    {
      height: 8,
      width,
    },
  );
  for (const line of chart) println(`  ${c.yellow(line)}`);
  println(
    `  ${timeAxis(Date.parse(trend[0]!.bucket), Date.parse(trend[trend.length - 1]!.bucket), width, 2)}`,
  );
  println(c.dim("  (scenario-adjusted projection; the trend total is printed above it)"));
  println();

  const contributions = response.scenario?.contributions ?? [];
  if (contributions.length > 0) {
    printTable(contributions, [
      { header: "adjustment", value: (r) => r.label },
      { header: "kind", value: (r) => c.dim(r.kind.replace("_", " ")) },
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
    println();
    println(c.dim(`Not applied (outside this query's scope): ${outOfScope.join(", ")}.`));
  }
  if (response.scenario?.convertedFrom) {
    println(
      c.dim(
        `Amounts converted from ${response.scenario.convertedFrom} at the organization's stated rates.`,
      ),
    );
  }
  println();
  println(
    c.dim(
      "A scenario never changes recorded spend, and it does not change any budget's alerting " +
        "unless that budget separately opted into this model.",
    ),
  );
}
