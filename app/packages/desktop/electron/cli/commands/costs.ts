// `infrawrench costs` — org cost graphs in the terminal, backed by the same
// /costs/query API the web + desktop dashboards use.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { RangeFlags } from "../args";
import { c, printJson, println, formatMoney, seriesColor } from "../output";
import { barChart, sparkline } from "../charts";

const GROUP_DIMENSIONS = ["provider", "account", "service", "region", "resource"] as const;

interface CostSeries {
  key: string;
  label: string;
  currency: string;
  points: Array<{ bucket: string; amount: number }>;
}

interface CostQueryResponse {
  series: CostSeries[];
  currencies: string[];
  totals: Record<string, number>;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function cmdCosts(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Cost data lives in Infrawrench Cloud — there is no local cost history.");
  }
  const org = await resolveOrg(ctx);

  const groupBy = range.groupBy ?? "provider";
  if (groupBy !== "none" && !GROUP_DIMENSIONS.includes(groupBy as never)) {
    throw new CliError(
      `--group-by must be one of none, ${GROUP_DIMENSIONS.join(", ")} — got "${groupBy}".`,
    );
  }

  const days = range.last ? Math.max(1, Math.round(parseLastDays(range.last))) : 30;
  const to = range.to ?? isoDay(Date.now());
  const from = range.from ?? isoDay(Date.parse(to) - (days - 1) * 86_400_000);

  const response = await orgFetch<CostQueryResponse>(org.id, "/costs/query", {
    method: "POST",
    body: JSON.stringify({
      from,
      to,
      binning: "daily",
      groupBy,
      filters: [],
      topN: 8,
      comparePreviousPeriod: false,
      forecast: false,
    }),
  });

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, from, to, groupBy, ...response });
    return;
  }

  const { series, totals } = response;
  if (series.length === 0) {
    println(c.dim("No cost data yet. Connect a provider account with billing access."));
    return;
  }

  const totalLine = Object.entries(totals)
    .map(([currency, amount]) => formatMoney(amount, currency))
    .join(" + ");
  println(`${c.bold(org.displayName)} ${c.dim(`· ${from} → ${to}`)}  ${c.bold(totalLine)}`);
  println();

  // Daily total trend across all series (single-currency assumption per line).
  const byBucket = new Map<string, number>();
  for (const s of series) {
    for (const p of s.points) byBucket.set(p.bucket, (byBucket.get(p.bucket) ?? 0) + p.amount);
  }
  const buckets = [...byBucket.keys()].sort();
  const dailyTotals = buckets.map((b) => byBucket.get(b)!);
  const sparkWidth = Math.min(60, Math.max(20, buckets.length));
  println(`${c.dim("daily")} ${seriesColor(0)(sparkline(dailyTotals, sparkWidth))}`);
  println();

  const items = series.map((s, idx) => {
    const total = s.points.reduce((sum, p) => sum + p.amount, 0);
    return {
      label: s.key === "__other__" ? c.dim("other") : s.label,
      value: total,
      display: formatMoney(total, s.currency),
      colorIndex: idx,
    };
  });
  for (const line of barChart(items, 32)) println(line);
}

/** `--last 30d|12w|3m` for costs — day-granularity spans. */
function parseLastDays(text: string): number {
  const match = /^(\d+)([dwm])$/.exec(text);
  if (!match) {
    throw new CliError(`Invalid --last "${text}" for costs — use forms like 7d, 30d, 12w, 3m`, 2);
  }
  const n = Number(match[1]);
  return n * { d: 1, w: 7, m: 30 }[match[2] as "d" | "w" | "m"]!;
}
