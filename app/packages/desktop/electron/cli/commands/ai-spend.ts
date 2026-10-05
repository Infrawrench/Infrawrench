// `infrawrench ai-spend`: billed AI spend split by caller (team, user,
// feature…), with per-source match rates and per-provider coverage, and
// `infrawrench ai-spend sources`: the configured request-log sources and their
// collection state. Reads over the same endpoints the Settings → AI
// Attribution page uses; wire shapes are client-core types, imported type-only
// so the CLI keeps its zero-runtime-dependency rule.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  AiAttributionDimension,
  AiAttributionStats,
  AiRequestSource,
  AiSpendBreakdown,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags } from "../args";
import { resolveDateRange } from "../args";
import { c, printJson, println, printTable, formatMoney } from "../output";
import { barChart } from "../charts";

function pct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : `${Math.round(value * 10) / 10}%`;
}

export async function cmdAiSpend(
  ctx: CliContext,
  range: RangeFlags,
  dimensionArg: string | undefined,
): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "AI attribution runs over your org's collected cloud spend, so it is cloud mode only.",
    );
  }
  const org = await resolveOrg(ctx);
  const { from, to } = resolveDateRange(range);

  const { dimensions } = await orgFetch<{ dimensions: AiAttributionDimension[] }>(
    org.id,
    "/ai-attribution/dimensions",
  );
  const dimension = dimensionArg ?? dimensions[0]?.key;
  if (dimensionArg && !dimensions.some((d) => d.key === dimensionArg)) {
    throw new CliError(
      `No caller dimension "${dimensionArg}". Known: ${dimensions.map((d) => d.key).join(", ") || "none"}.`,
    );
  }
  const [stats, spend] = await Promise.all([
    orgFetch<AiAttributionStats>(org.id, `/ai-attribution/stats?from=${from}&to=${to}`),
    dimension
      ? orgFetch<AiSpendBreakdown>(
          org.id,
          `/ai-attribution/spend?from=${from}&to=${to}&dimension=${encodeURIComponent(dimension)}`,
        )
      : Promise.resolve(null),
  ]);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, from, to, dimensions, stats, spend });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim(`· AI spend by caller, ${from} → ${to}`)}`);
  println();

  if (stats.providers.length === 0) {
    println(
      c.dim(
        "No AI spend attributed in this range. Add a request-log source and map metadata keys to dimensions under Settings → AI Attribution.",
      ),
    );
  } else {
    printTable(stats.providers, [
      { header: "provider", value: (p) => c.bold(p.provider) },
      { header: "billed", value: (p) => formatMoney(p.billedAmount, p.currency), align: "right" },
      {
        header: "attributed",
        value: (p) => formatMoney(p.attributedAmount, p.currency),
        align: "right",
      },
      {
        header: "unattributed",
        value: (p) => formatMoney(p.unattributedAmount, p.currency),
        align: "right",
      },
    ]);
  }

  if (stats.sources.length > 0) {
    println();
    printTable(stats.sources, [
      { header: "source", value: (s) => s.name },
      { header: "requests", value: (s) => s.requests.toLocaleString(), align: "right" },
      {
        header: "matched",
        value: (s) => pct(s.requests > 0 ? (s.matchedRequests / s.requests) * 100 : null),
        align: "right",
      },
      { header: "ambiguous", value: (s) => s.ambiguousRequests.toLocaleString(), align: "right" },
      { header: "unmatched", value: (s) => s.unmatchedRequests.toLocaleString(), align: "right" },
      { header: "bill covered", value: (s) => pct(s.coveragePercent), align: "right" },
    ]);
  }

  if (!spend) {
    println();
    println(c.dim("No caller dimensions mapped yet, so nothing is split by caller."));
    return;
  }
  println();
  println(`${c.bold(dimension!)} ${c.dim(`(tag key ${spend.tagKey})`)}`);
  if (spend.rows.length === 0) {
    println(c.dim("No attributed spend in this range."));
    return;
  }
  const items = spend.rows.slice(0, 15).map((row, idx) => ({
    label: row.value || "(no value)",
    value: row.amount,
    display: formatMoney(row.amount, row.currency),
    colorIndex: idx,
  }));
  for (const line of barChart(items, 32)) println(line);
}

export async function cmdAiSources(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Request-log sources are org-level cloud state, so this is cloud mode only.",
    );
  }
  const org = await resolveOrg(ctx);
  const { sources } = await orgFetch<{ sources: AiRequestSource[] }>(
    org.id,
    "/ai-attribution/sources",
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, sources });
    return;
  }
  if (sources.length === 0) {
    println(c.dim("No request-log sources. Add one under Settings → AI Attribution."));
    return;
  }
  printTable(sources, [
    { header: "name", value: (s) => (s.enabled ? c.bold(s.name) : c.dim(`${s.name} (paused)`)) },
    {
      header: "kind",
      value: (s) => (s.accountName ? `${s.sourceKindId} ${c.dim(s.accountName)}` : s.sourceKindId),
    },
    { header: "collected through", value: (s) => s.collectedThrough ?? c.dim("not yet") },
    { header: "status", value: (s) => (s.lastError ? c.red(s.lastError) : c.green("ok")) },
  ]);
}
