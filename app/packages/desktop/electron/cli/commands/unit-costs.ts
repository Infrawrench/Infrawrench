/**
 * `infrawrench unit-costs`: business metrics and what a unit of the business
 * actually costs.
 *
 * Deliberately not `infrawrench metrics`: that verb already means "chart a
 * resource's provider metrics" and taking it would break a shipped command.
 * `unit-costs` names the question this command answers, and hyphenated
 * top-level verbs are already the house style (`status-pages`, `ssh-fanout`).
 *
 * With no argument it lists the org's metrics and how well each is being fed:
 * a metric nobody is reporting produces a chart made entirely of gaps, and that
 * failure is silent everywhere else. With a metric key it draws the ratio.
 *
 * The one rule this command must never break: **a period with no reported
 * metric value prints as a dash, never as 0.** The chart skips it and the table
 * dims it. A CLI that printed `$0.00` for an unmeasured day would be believed
 * exactly as readily as a chart that drew a zero.
 */
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  BusinessMetric,
  BusinessMetricLabelSummary,
  CostBasis,
  UnitCostQueryRequest,
  UnitCostQueryResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags, UnitCostFlags } from "../args";
import { resolveDateRange } from "../args";
import { c, printJson, println, printTable, formatNumber } from "../output";
import {
  formatUnitCostRatio,
  parseUnitCostLabelFlag,
  parseUnitCostModeFlag,
  parseUnitCostScaleFlag,
  unitCostRatioLabel,
  type CliUnitCostMode,
} from "../format";
import { sparkline } from "../charts";

const COST_BASES = ["cash", "amortized", "blended"] as const;

/** `--basis cash|amortized|blended`, defaulting to cash. */
function parseBasis(raw: string | undefined): CostBasis | undefined {
  if (raw === undefined) return undefined;
  const match = COST_BASES.find((b) => b === raw);
  if (!match) {
    throw new CliError(`--basis must be one of ${COST_BASES.join(", ")} — got "${raw}".`, 2);
  }
  return match;
}

function parseCurrency(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new CliError(`--currency must be a three-letter code like USD — got "${raw}".`, 2);
  }
  return code;
}

/** How well a metric is being fed, as one short phrase. */
function coverageLabel(metric: BusinessMetric): string {
  if (!metric.coverage) return "never reported";
  const { firstDay, lastDay, reportedDays } = metric.coverage;
  const span =
    Math.round(
      (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  const missing = span - reportedDays;
  return missing > 0 ? `${reportedDays}d (${missing} missing)` : `${reportedDays}d`;
}

/** `infrawrench unit-costs`: the org's business metrics. */
export async function cmdBusinessMetrics(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Business metrics live in Infrawrench Cloud — they only mean anything next to the spend " +
        "they divide, and that has no local equivalent.",
    );
  }
  const org = await resolveOrg(ctx);
  const res = await orgFetch<{ metrics: BusinessMetric[] }>(org.id, "/business-metrics");
  const metrics = res.metrics ?? [];

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, metrics });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim("· business metrics")}`);
  println();

  if (metrics.length === 0) {
    println(
      c.dim(
        "No business metrics yet. Create one on the Costs panel, then report its daily values " +
          "from a workflow with infra.businessMetrics.write, over the API, or by hand.",
      ),
    );
    return;
  }

  printTable(metrics, [
    { header: "key", value: (m) => m.key },
    { header: "name", value: (m) => m.name },
    { header: "unit", value: (m) => m.unit },
    { header: "kind", value: (m) => (m.kind === "currency" ? `revenue (${m.currency})` : "count") },
    {
      header: "scope",
      value: (m) =>
        m.costScope.length === 0
          ? c.dim("all spend")
          : `${m.costScope.length} filter${m.costScope.length === 1 ? "" : "s"}`,
    },
    {
      header: "reported",
      // Dimmed when there is nothing, because "never reported" is the answer
      // that explains an empty chart and it should read as a warning, not a
      // datum.
      value: (m) => (m.coverage ? coverageLabel(m) : c.yellow(coverageLabel(m))),
    },
  ]);
  println();
  println(
    c.dim(
      "Run `infrawrench unit-costs <key>` for the cost per unit. Only revenue metrics support " +
        "--margin.",
    ),
  );
}

/** `infrawrench unit-costs --usage-units`: the usage units the org's cost rows carry. */
export async function cmdUsageUnits(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Usage units come from Infrawrench Cloud's cost store.");
  }
  const org = await resolveOrg(ctx);
  const res = await orgFetch<{ units: Array<{ unit: string; usage: number; services: string[] }> }>(
    org.id,
    "/business-metrics/usage-units",
  );
  const units = res.units ?? [];
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, units });
    return;
  }
  println(`${c.bold(org.displayName)} ${c.dim("· usage units, last 90 days, most spend first")}`);
  println();
  if (units.length === 0) {
    println(c.dim("No cost rows report a usage quantity yet."));
    return;
  }
  printTable(units, [
    { header: "unit", value: (u) => u.unit },
    { header: "usage", align: "right", value: (u) => formatNumber(u.usage) },
    { header: "services", value: (u) => c.dim(u.services.join(", ")) },
  ]);
  println();
  println(c.dim('Run `infrawrench unit-costs --usage-unit "<unit>"` for the cost per unit.'));
}

/** `infrawrench unit-costs <metric> --labels`: label keys, values and mappings. */
async function printLabels(ctx: CliContext, orgId: string, orgName: string, metric: string) {
  const res = await orgFetch<{ labels: BusinessMetricLabelSummary[] }>(
    orgId,
    `/business-metrics/${encodeURIComponent(metric)}/labels`,
  );
  const labels = res.labels ?? [];
  if (ctx.flags.output === "json") {
    printJson({ org: orgId, metric, labels });
    return;
  }
  println(`${c.bold(orgName)} ${c.dim(`· ${metric} · labels`)}`);
  println();
  if (labels.length === 0) {
    println(c.dim("No labelled values yet. Report values with labels to split this metric."));
    return;
  }
  printTable(labels, [
    { header: "label", value: (l) => l.key },
    {
      header: "maps to",
      value: (l) =>
        !l.mapping
          ? c.dim("not mapped (raw metric only)")
          : l.mapping.kind === "cost_centre"
            ? "cost centre"
            : l.mapping.tagKey
              ? `${l.mapping.dimension} ${l.mapping.tagKey}`
              : l.mapping.dimension,
    },
    {
      header: "values",
      value: (l) =>
        `${l.values.slice(0, 6).join(", ")}${l.values.length > 6 || l.truncated ? c.dim(" …") : ""}`,
    },
  ]);
}

/** `infrawrench unit-costs <metric>` (or `--usage-unit <unit>`): the calculation over time. */
export async function cmdUnitCosts(
  ctx: CliContext,
  metric: string | null,
  range: RangeFlags,
  /** `--margin`, kept as the shorthand it always was for `--mode margin`. */
  margin: boolean,
  flags: UnitCostFlags,
): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Unit costs live in Infrawrench Cloud — there is no local cost history.");
  }
  const org = await resolveOrg(ctx);

  if (metric && flags.listLabels) {
    await printLabels(ctx, org.id, org.displayName, metric);
    return;
  }

  let mode: CliUnitCostMode | null;
  let scale: number | null;
  let labelFilters: ReturnType<typeof parseUnitCostLabelFlag>[];
  try {
    mode = parseUnitCostModeFlag(flags.mode);
    scale = parseUnitCostScaleFlag(flags.scale);
    labelFilters = flags.labels.map(parseUnitCostLabelFlag);
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), 2);
  }
  if (margin) {
    if (mode && mode !== "margin") throw new CliError("--margin and --mode disagree.", 2);
    mode = "margin";
  }
  if (flags.usageUnit) {
    if (mode && mode !== "usage_unit_cost") {
      throw new CliError("--usage-unit is the per-usage-unit calculation; drop --mode.", 2);
    }
    mode = "usage_unit_cost";
  }
  if (mode === "usage_unit_cost" && !flags.usageUnit) {
    throw new CliError(
      "Cost per usage unit needs --usage-unit. List the units with `infrawrench unit-costs --usage-units`.",
      2,
    );
  }
  if (mode !== "usage_unit_cost" && !metric) {
    throw new CliError("Name a metric key, or pass --usage-unit for cost per usage unit.", 2);
  }

  const binning = range.groupBy ?? "daily";
  if (!["daily", "weekly", "monthly", "cumulative"].includes(binning)) {
    throw new CliError(
      `--group-by must be one of daily, weekly, monthly, cumulative — got "${binning}".`,
      2,
    );
  }

  const { from, to } = resolveDateRange(range);

  const basis = parseBasis(range.basis);
  const displayCurrency = parseCurrency(range.currency);
  const request: UnitCostQueryRequest = {
    from,
    to,
    binning: binning as UnitCostQueryRequest["binning"],
    ...(range.where ? { query: range.where } : {}),
    ...(basis ? { costBasis: basis } : {}),
    ...(displayCurrency ? { displayCurrency } : {}),
  };
  // Set only when asked, so a default never reaches the wire: "absent means
  // unit cost" is the contract, and sending it would make every request differ
  // from the one an older client sends for no behavioural reason.
  if (mode && mode !== "unit_cost") request.mode = mode;
  if (scale && scale !== 1) request.scale = scale as UnitCostQueryRequest["scale"];
  if (labelFilters.length > 0) request.labelFilters = labelFilters;
  if (flags.split) request.groupByLabel = flags.split;
  if (flags.usageUnit) request.usageUnit = flags.usageUnit;

  const response = await orgFetch<UnitCostQueryResponse>(
    org.id,
    mode === "usage_unit_cost"
      ? "/business-metrics/usage-unit-costs"
      : `/business-metrics/${encodeURIComponent(metric!)}/unit-costs`,
    { method: "POST", body: JSON.stringify(request) },
  );

  if (ctx.flags.output === "json") {
    // The resolved inputs first, then the response; the response's own
    // `metric`, `mode` and `binning` are authoritative, so they are spread last.
    printJson({
      org: org.id,
      requestedMetric: metric,
      from,
      to,
      costBasis: basis ?? "cash",
      displayCurrency: displayCurrency ?? null,
      margin: response.mode === "margin",
      ...response,
    });
    return;
  }

  const resolvedMode = response.mode as CliUnitCostMode;
  const unit =
    resolvedMode === "usage_unit_cost"
      ? (response.usageUnit ?? "unit")
      : (response.metric?.unit ?? "unit");
  const subject = response.metric?.name ?? `usage in ${response.usageUnit ?? "?"}`;
  const labelFor = (currency: string) =>
    unitCostRatioLabel(resolvedMode, currency, unit, response.scale);
  const seriesName = (s: UnitCostQueryResponse["series"][number]) =>
    s.label ? (s.label.other ? "Other" : (s.label.value ?? "(no label)")) : s.currency;

  const scope = [`${from} → ${to}`, binning, basis ?? "cash"].join(" · ");
  const headline = response.groupByLabel
    ? `${response.series.length} values of ${response.groupByLabel}`
    : response.series
        .map((s) => {
          const margin =
            s.overallAbsoluteMargin !== undefined && s.overallAbsoluteMargin !== null
              ? ` (${formatNumber(s.overallAbsoluteMargin)} ${s.currency})`
              : "";
          return `${formatUnitCostRatio(s.overallValue, resolvedMode)} ${labelFor(s.currency)}${margin}`;
        })
        .join("  ");
  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${subject} · ${scope}`)}  ${c.bold(headline || c.dim("—"))}`,
  );
  println();

  if (response.series.length === 0) {
    println(
      c.dim(`No spend in scope for ${subject} over this range, so there is nothing to divide.`),
    );
    return;
  }

  // The caveats go above the numbers, not below: a reader who scrolls away
  // after the chart must not miss the fact that some periods are unmeasured.
  if (response.gapBuckets > 0) {
    println(
      `${c.yellow("!")} ${c.bold(String(response.gapBuckets))} ${c.dim(
        "period(s) have nothing to divide by — shown as “—”, not as zero. The spend is known; the ratio is not.",
      )}`,
    );
  }
  if (response.partialBuckets > 0) {
    println(
      `${c.yellow("!")} ${c.bold(String(response.partialBuckets))} ${c.dim(
        "period(s) are only partly reported, so the ratio there reads high.",
      )}`,
    );
  }
  const currencies = new Set(response.series.map((s) => s.currency));
  if (currencies.size > 1) {
    println(
      `${c.yellow("!")} ${c.dim(
        "spend spans currencies with no stated rate, so each divides the metric on its own — these series are not comparable to each other",
      )}`,
    );
  }
  if (response.gapBuckets > 0 || response.partialBuckets > 0 || currencies.size > 1) {
    println();
  }

  // A split prints one summary row per label value: twenty-five full tables
  // would bury the answer. --json carries every point.
  if (response.groupByLabel) {
    printTable(response.series, [
      { header: response.groupByLabel, value: (s) => seriesName(s) },
      {
        header: labelFor(response.series[0]?.currency ?? ""),
        align: "right",
        value: (s) =>
          s.overallValue === null ? c.dim("—") : formatUnitCostRatio(s.overallValue, resolvedMode),
      },
      {
        header: "cost",
        align: "right",
        value: (s) => `${formatNumber(s.overallCost)} ${s.currency}`,
      },
      {
        header: unit,
        align: "right",
        value: (s) =>
          s.overallMetricValue === null ? c.dim("—") : formatNumber(s.overallMetricValue),
      },
      {
        header: "trend",
        value: (s) => {
          const drawn = s.points.map((p) => p.value).filter((v): v is number => v !== null);
          return drawn.length > 1 ? sparkline(drawn, Math.min(drawn.length, 24)) : "";
        },
      },
    ]);
    if (response.costPerLabel === false) {
      println();
      println(
        c.dim(
          `${response.groupByLabel} is not mapped to spend, so every row's cost is the whole scope's.`,
        ),
      );
    }
    return;
  }

  for (const series of response.series) {
    const label = labelFor(series.currency);
    // The sparkline can only draw numbers, so gaps are dropped from it, which
    // is why the table below it is the authoritative rendering and prints every
    // bucket, gap included.
    const drawn = series.points.map((p) => p.value).filter((v): v is number => v !== null);
    if (drawn.length > 1) {
      println(`${c.dim(label)} ${sparkline(drawn, Math.min(drawn.length, 48))}`);
    }
    printTable(series.points, [
      { header: "period", value: (p) => p.bucket },
      {
        header: label,
        align: "right",
        // The one rule: a gap is a dash. Never 0, never blank.
        value: (p) => (p.value === null ? c.dim("—") : formatUnitCostRatio(p.value, resolvedMode)),
      },
      {
        header: "cost",
        align: "right",
        value: (p) => `${formatNumber(p.cost)} ${series.currency}`,
      },
      {
        header: unit,
        align: "right",
        value: (p) => (p.metricValue === null ? c.dim("—") : formatNumber(p.metricValue)),
      },
      ...(resolvedMode === "margin"
        ? [
            {
              header: "margin",
              align: "right" as const,
              value: (p: (typeof series.points)[number]) =>
                p.absoluteMargin === null || p.absoluteMargin === undefined
                  ? c.dim("—")
                  : `${formatNumber(p.absoluteMargin)} ${series.currency}`,
            },
          ]
        : []),
      {
        header: "why",
        value: (p) =>
          p.gap
            ? c.dim(GAP_REASONS[p.gap] ?? p.gap)
            : p.reportedDays > 0 && p.reportedDays < p.bucketDays
              ? c.yellow(`partial ${p.reportedDays}/${p.bucketDays}d`)
              : "",
      },
    ]);
    println();
  }

  println(
    c.dim(
      "Each period's ratio is that period's summed cost over its summed denominator; the " +
        "headline is the summed cost over the summed denominator across the whole range, not an " +
        "average of the rows.",
    ),
  );
}

/** Short reasons for the gap column, matching the API's enum. */
const GAP_REASONS: Record<string, string> = {
  no_metric_value: "not reported",
  non_positive_metric_value: "value was 0 or negative",
  unconvertible_currency: "no rate to the metric's currency",
  no_usage: "no usage in this unit",
};
