import type { MetricSeries } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./clients/shared.js";
import { fetchWorkerTelemetrySeries } from "./clients/worker-observability.js";

/**
 * Worker metrics. Two sources, fetched in parallel:
 *
 * 1. GraphQL `workersInvocationsAdaptiveGroups` (always available, any plan):
 *    requests / errors / subrequests, CPU and wall time p50/p99, and the
 *    invocation count split by `status` (success, scriptThrewException,
 *    exceededResources, clientDisconnected, internalError...). Field names
 *    checked against the schema's `AccountWorkersInvocationsAdaptive*` types:
 *    quantiles `cpuTimeP50..P999` and `wallTimeP50..P999` are microseconds.
 *    https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
 * 2. The Workers Observability telemetry API (only when the Worker has
 *    observability on): log events by level and trace span count/duration;
 *    see `fetchWorkerTelemetrySeries`.
 *
 * Buckets use the truncated time dimensions (`datetimeFiveMinutes`,
 * `datetimeHour`, `datetimeSixHours`) rather than `datetime`, which is
 * per-second on adaptive datasets and blows through the row limit on any
 * busy Worker.
 */
export async function fetchWorkerMetricSeries(
  api: CloudflareApi,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const scriptName = resourceId.split(":").pop();
  if (!scriptName) return [];

  let cfAccountId: string;
  try {
    cfAccountId = await api.getAccountId();
  } catch {
    return [];
  }

  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - 24 * 3_600_000;
  const [graph, telemetry] = await Promise.all([
    fetchInvocationSeries(api, cfAccountId, scriptName, startMs, endMs),
    fetchWorkerTelemetrySeries(api, scriptName, startMs, endMs).catch(() => []),
  ]);
  return [...graph, ...telemetry];
}

/** Pick the coarsest bucket that still gives a readable chart for the window. */
export function workerBucketDimension(spanMs: number): string {
  if (spanMs <= 6 * 3_600_000) return "datetimeFiveMinutes";
  if (spanMs <= 8 * 24 * 3_600_000) return "datetimeHour";
  return "datetimeSixHours";
}

/** Readable names for the `status` dimension's values. */
const STATUS_LABELS: Record<string, string> = {
  success: "Success",
  scriptThrewException: "Exception",
  exceededResources: "Exceeded resources",
  exceededCpu: "Exceeded CPU",
  exceededMemory: "Exceeded memory",
  clientDisconnected: "Client disconnected",
  internalError: "Internal error",
  canceled: "Canceled",
  responseStreamDisconnected: "Response stream disconnected",
};

interface TotalsGroup {
  dimensions: Record<string, string>;
  sum: { requests?: number; subrequests?: number; errors?: number };
  quantiles: {
    cpuTimeP50?: number;
    cpuTimeP99?: number;
    wallTimeP50?: number;
    wallTimeP99?: number;
  };
}
interface StatusGroup {
  dimensions: Record<string, string>;
  sum: { requests?: number };
}

async function fetchInvocationSeries(
  api: CloudflareApi,
  cfAccountId: string,
  scriptName: string,
  startMs: number,
  endMs: number,
): Promise<MetricSeries[]> {
  const dim = workerBucketDimension(endMs - startMs);
  const filter = "{ scriptName: $script, datetime_geq: $from, datetime_lt: $to }";
  const query = `query W($account: String!, $script: String!, $from: Time!, $to: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          totals: workersInvocationsAdaptiveGroups(
            limit: 2000
            filter: ${filter}
            orderBy: [${dim}_ASC]
          ) {
            dimensions { ${dim} }
            sum { requests subrequests errors }
            quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
          }
          byStatus: workersInvocationsAdaptiveGroups(
            limit: 5000
            filter: ${filter}
            orderBy: [${dim}_ASC]
          ) {
            dimensions { ${dim} status }
            sum { requests }
          }
        }
      }
    }`;

  interface Resp {
    data?: {
      viewer?: { accounts?: Array<{ totals?: TotalsGroup[]; byStatus?: StatusGroup[] }> };
    };
  }

  let totals: TotalsGroup[] = [];
  let byStatus: StatusGroup[] = [];
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          account: cfAccountId,
          script: scriptName,
          from: new Date(startMs).toISOString(),
          to: new Date(endMs).toISOString(),
        },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Resp;
    const account = json.data?.viewer?.accounts?.[0];
    totals = account?.totals ?? [];
    byStatus = account?.byStatus ?? [];
  } catch {
    return [];
  }

  const tsOf = (g: { dimensions: Record<string, string> }): number =>
    new Date(String(g.dimensions[dim] ?? "")).getTime();
  const pick = (label: string, unit: string, value: (g: TotalsGroup) => number | undefined) => ({
    label,
    unit,
    points: totals.map((g) => ({ timestamp: tsOf(g), value: Number(value(g) ?? 0) })),
  });

  // Labels and units of the first five match what this chart has always
  // emitted, so saved metric alerts and custom graphs keep resolving.
  const series: MetricSeries[] = [
    pick("Requests", "requests", (g) => g.sum.requests),
    pick("Errors", "errors", (g) => g.sum.errors),
    pick("Subrequests", "subrequests", (g) => g.sum.subrequests),
    pick("CPU Time p50", "μs", (g) => g.quantiles.cpuTimeP50),
    pick("CPU Time p99", "μs", (g) => g.quantiles.cpuTimeP99),
    pick("Wall Time p50", "μs", (g) => g.quantiles.wallTimeP50),
    pick("Wall Time p99", "μs", (g) => g.quantiles.wallTimeP99),
  ];

  // Non-success invocations by status: the "why" behind the Errors line.
  const perStatus = new Map<string, Map<number, number>>();
  for (const g of byStatus) {
    const status = String(g.dimensions["status"] ?? "");
    if (!status || status === "success") continue;
    let m = perStatus.get(status);
    if (!m) {
      m = new Map();
      perStatus.set(status, m);
    }
    const t = tsOf(g);
    m.set(t, (m.get(t) ?? 0) + Number(g.sum.requests ?? 0));
  }
  for (const [status, m] of [...perStatus.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    series.push({
      label: `Invocations: ${STATUS_LABELS[status] ?? status}`,
      unit: "invocations",
      points: [...m.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, value]) => ({ timestamp, value })),
    });
  }

  return series.filter((s) => s.points.some((p) => p.value > 0));
}
