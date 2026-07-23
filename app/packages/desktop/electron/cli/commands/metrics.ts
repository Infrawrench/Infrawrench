// `infrawrench metrics <resource-id>` — historical metric series from the
// cloud's ClickHouse store, rendered as terminal charts. Cloud-only: local
// mode has no metric history (the poller writes ClickHouse for org resources).
import { CliError, listCloudAccounts, orgFetch, resolveOrg, type CliContext } from "../context";
import type { RangeFlags } from "../args";
import { parseDuration } from "../args";
import { c, printJson, println, formatNumber } from "../output";
import { lineChart, timeAxis } from "../charts";

interface MetricSeries {
  label: string;
  unit?: string;
  points: Array<{ timestamp: number; value: number }>;
}

export async function cmdMetrics(
  ctx: CliContext,
  resourceId: string,
  range: RangeFlags,
): Promise<void> {
  if (!resourceId) throw new CliError("Usage: infrawrench metrics <resource-id> [--last 6h]");
  if (ctx.flags.local) {
    throw new CliError(
      "Metric history lives in Infrawrench Cloud — local resources have none. Pass --org for a cloud resource.",
    );
  }
  const org = await resolveOrg(ctx);

  // {accountId}:{resourceTypeId}:{externalId} — the account resolves the plugin.
  const [accountId, resourceTypeId] = resourceId.split(":");
  if (!accountId || !resourceTypeId) {
    throw new CliError(
      `"${resourceId}" doesn't look like a resource id (accountId:typeId:externalId).`,
    );
  }
  const account = (await listCloudAccounts(org.id)).find((a) => a.id === accountId);
  if (!account) throw new CliError(`Account ${accountId} not found in ${org.displayName}.`);

  const endMs = range.to ? Date.parse(range.to) : Date.now();
  const startMs = range.from ? Date.parse(range.from) : endMs - parseDuration(range.last ?? "1h");
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new CliError("Invalid --from/--to timestamp (use ISO 8601).");
  }

  const { series } = await orgFetch<{ series: MetricSeries[] }>(
    org.id,
    `/resources/${encodeURIComponent(account.pluginId)}/${encodeURIComponent(resourceTypeId)}/metrics`,
    {
      method: "POST",
      body: JSON.stringify({ accountId, resourceId, startMs, endMs }),
    },
  );

  const filtered = range.series
    ? series.filter((s) => s.label.toLowerCase().includes(range.series!.toLowerCase()))
    : series;

  if (ctx.flags.output === "json") {
    printJson({ resourceId, startMs, endMs, series: filtered });
    return;
  }

  if (filtered.length === 0) {
    println(
      c.dim(
        series.length === 0
          ? "No metric points. Only resources pinned to a dashboard accumulate history."
          : `No series matches "${range.series}". Available: ${series.map((s) => s.label).join(", ")}`,
      ),
    );
    return;
  }

  const width = Math.min(72, Math.max(30, (process.stdout.columns ?? 80) - 14));
  filtered.forEach((s, idx) => {
    if (idx > 0) println();
    const values = s.points.map((p) => p.value);
    const last = values[values.length - 1];
    const stats =
      values.length > 0
        ? ` ${c.dim("min")} ${formatNumber(Math.min(...values), s.unit)}  ${c.dim("max")} ${formatNumber(Math.max(...values), s.unit)}  ${c.dim("now")} ${formatNumber(last!, s.unit)}`
        : "";
    println(`${c.bold(s.label)}${stats}`);
    for (const line of lineChart(values, { width, height: 7, unit: s.unit, colorIndex: idx })) {
      println(line);
    }
    const axisPad = Math.max(
      ...[Math.min(...values, 0), Math.max(...values)].map((v) => formatNumber(v, s.unit).length),
      0,
    );
    println(timeAxis(startMs, endMs, width, axisPad));
  });
}
