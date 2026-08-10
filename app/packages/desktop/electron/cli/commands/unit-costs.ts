/**
 * `infrawrench unit-costs` — business metrics and what a unit of the business
 * actually costs.
 *
 * Deliberately not `infrawrench metrics`: that verb already means "chart a
 * resource's provider metrics" and taking it would break a shipped command.
 * `unit-costs` names the question this command answers, and hyphenated
 * top-level verbs are already the house style (`status-pages`, `ssh-fanout`).
 *
 * With no argument it lists the org's metrics and how well each is being fed —
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
  CostBasis,
  UnitCostQueryRequest,
  UnitCostQueryResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags } from "../args";
import { parseLastDays } from "../args";
import { c, printJson, println, printTable, formatNumber } from "../output";
import { formatUnitCostRatio, unitCostRatioLabel } from "../format";
import { sparkline } from "../charts";

const COST_BASES = ["cash", "amortized"] as const;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `--basis cash|amortized`, defaulting to cash. */
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

/** `infrawrench unit-costs` — the org's business metrics. */
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

/** `infrawrench unit-costs <metric>` — the ratio over time. */
export async function cmdUnitCosts(
  ctx: CliContext,
  metric: string,
  range: RangeFlags,
  /**
   * `--margin`. A property of the *question* (which ratio) rather than of the
   * range, so it is passed alongside rather than folded into `RangeFlags`.
   */
  margin: boolean,
): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Unit costs live in Infrawrench Cloud — there is no local cost history.");
  }
  const org = await resolveOrg(ctx);

  const binning = range.groupBy ?? "daily";
  if (!["daily", "weekly", "monthly", "cumulative"].includes(binning)) {
    throw new CliError(
      `--group-by must be one of daily, weekly, monthly, cumulative — got "${binning}".`,
      2,
    );
  }

  const days = range.last ? Math.max(1, Math.round(parseLastDays(range.last))) : 30;
  const to = range.to ?? isoDay(Date.now());
  const from = range.from ?? isoDay(Date.parse(to) - (days - 1) * 86_400_000);

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
  // Set only when asked, so a `false` never reaches the wire — "absent means
  // unit cost" is the contract, and sending the default would make every
  // request differ from the one an older client sends for no behavioural reason.
  if (margin) request.mode = "margin";

  const response = await orgFetch<UnitCostQueryResponse>(
    org.id,
    `/business-metrics/${encodeURIComponent(metric)}/unit-costs`,
    { method: "POST", body: JSON.stringify(request) },
  );

  if (ctx.flags.output === "json") {
    // The resolved inputs first, then the response — but the response's own
    // `metric` and `binning` are the authoritative ones (the server resolved a
    // key into the full metric), so they are spread last and the echoed
    // request keys are named distinctly.
    printJson({
      org: org.id,
      requestedMetric: metric,
      from,
      to,
      costBasis: basis ?? "cash",
      displayCurrency: displayCurrency ?? null,
      margin,
      ...response,
    });
    return;
  }

  const mode = response.mode;
  const scope = [`${from} → ${to}`, binning, basis === "amortized" ? "amortized" : "cash"].join(
    " · ",
  );
  const headline = response.series
    .map(
      (s) =>
        `${formatUnitCostRatio(s.overallValue, mode)} ${unitCostRatioLabel(mode, s.currency, response.metric.unit)}`,
    )
    .join("  ");
  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${response.metric.name} · ${scope}`)}  ${c.bold(headline || c.dim("—"))}`,
  );
  println();

  if (response.series.length === 0) {
    println(
      c.dim(
        `No spend in scope for ${response.metric.key} over this range, so there is nothing to divide.`,
      ),
    );
    return;
  }

  // The caveats go above the numbers, not below: a reader who scrolls away
  // after the chart must not miss the fact that some periods are unmeasured.
  if (response.gapBuckets > 0) {
    println(
      `${c.yellow("!")} ${c.bold(String(response.gapBuckets))} ${c.dim(
        "period(s) have no reported metric value — shown as “—”, not as zero. The spend is known; the ratio is not.",
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
  if (response.series.length > 1) {
    println(
      `${c.yellow("!")} ${c.dim(
        "spend spans currencies with no stated rate, so each divides the metric on its own — these series are not comparable to each other",
      )}`,
    );
  }
  if (response.gapBuckets > 0 || response.partialBuckets > 0 || response.series.length > 1) {
    println();
  }

  for (const series of response.series) {
    const label = unitCostRatioLabel(mode, series.currency, response.metric.unit);
    // The sparkline can only draw numbers, so gaps are dropped from it — which
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
        value: (p) => (p.value === null ? c.dim("—") : formatUnitCostRatio(p.value, mode)),
      },
      {
        header: "cost",
        align: "right",
        value: (p) => `${formatNumber(p.cost)} ${series.currency}`,
      },
      {
        header: response.metric.unit,
        align: "right",
        value: (p) => (p.metricValue === null ? c.dim("—") : formatNumber(p.metricValue)),
      },
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
      "Each period's ratio is that period's summed cost over its summed metric value; the " +
        "headline is the summed cost over the summed value across the whole range, not an " +
        "average of the rows.",
    ),
  );
}

/** Short reasons for the gap column, matching the API's enum. */
const GAP_REASONS: Record<string, string> = {
  no_metric_value: "not reported",
  non_positive_metric_value: "value was 0 or negative",
  unconvertible_currency: "no rate to the metric's currency",
};
