/**
 * The Logs tab on a branch, built from PlanetScale Insights
 * (`GET .../branches/{branch}/insights/errors` and `.../insights/anomalies`;
 * verified against the API spec, October 2026). Both need the service token's
 * `read_database` access.
 *
 * PlanetScale's raw branch logs are only reachable through a signed URL
 * (`POST .../logs/signatures`) whose response format is not documented, so
 * the tab shows the two Insights feeds instead: grouped query errors and
 * latency anomalies, newest first, each over the last day.
 */

import type { LogsFetchParams, LogsFetchResult } from "@infrawrench/plugin-base";

export const INSIGHTS_LOG_CONTAINERS = ["query-errors", "anomalies"] as const;

interface ErrorSummary {
  started_at?: string;
  error_count?: number;
  time_per_query?: number;
  error_message?: string;
}

interface Anomaly {
  period_start?: string;
  period_end?: string;
  active?: boolean;
  minutes_in_violation?: number;
  correlations?: Array<{ r?: number; normalized_sql?: string; tablet_type?: string }> | null;
}

/** Insights pages hold 25 rows by default; the tab never needs more than one page. */
const MAX_ROWS = 100;

export async function fetchInsightsLog(
  fetchJson: <T>(path: string) => Promise<T>,
  branchPath: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const container = params.container === "anomalies" ? "anomalies" : INSIGHTS_LOG_CONTAINERS[0];
  const perPage = Math.min(Math.max(params.tailLines ?? 50, 1), MAX_ROWS);
  const query = new URLSearchParams({ period: "1d", per_page: String(perPage) });

  let lines: string[];
  if (container === "anomalies") {
    const data = await fetchJson<{ data?: Anomaly[] }>(
      `${branchPath}/insights/anomalies?${query.toString()}`,
    );
    lines = (data.data ?? [])
      .slice()
      .sort((a, b) => (a.period_start ?? "").localeCompare(b.period_start ?? ""))
      .map(formatAnomaly);
  } else {
    query.set("sort", "lastRun");
    query.set("dir", "desc");
    const data = await fetchJson<{ data?: ErrorSummary[] }>(
      `${branchPath}/insights/errors?${query.toString()}`,
    );
    // Asked newest first so the page is the latest errors; shown oldest
    // first like any log tail.
    lines = (data.data ?? []).slice().reverse().map(formatError);
  }

  const empty =
    container === "anomalies"
      ? "No latency anomalies on this branch in the last day.\n"
      : "No query errors on this branch in the last day.\n";
  return {
    text: lines.length > 0 ? lines.join("\n") + "\n" : empty,
    containers: [...INSIGHTS_LOG_CONTAINERS],
    activeContainer: container,
  };
}

function formatError(e: ErrorSummary): string {
  const count = e.error_count ?? 0;
  const avg = typeof e.time_per_query === "number" ? `, avg ${e.time_per_query.toFixed(1)} ms` : "";
  return `${e.started_at ?? ""}  ERROR  x${count}${avg}  ${oneLine(e.error_message ?? "")}`.trim();
}

function formatAnomaly(a: Anomaly): string {
  const state = a.active ? "ACTIVE" : "resolved";
  const window = `${a.period_start ?? "?"} to ${a.active ? "now" : (a.period_end ?? "?")}`;
  const minutes = a.minutes_in_violation ?? 0;
  const top = (a.correlations ?? [])
    .slice()
    .sort((x, y) => Math.abs(y.r ?? 0) - Math.abs(x.r ?? 0))[0];
  const cause = top?.normalized_sql
    ? `  likely cause (r=${(top.r ?? 0).toFixed(2)}): ${oneLine(top.normalized_sql)}`
    : "";
  return `${a.period_start ?? ""}  ANOMALY ${state}  ${window}, ${minutes} min over baseline${cause}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
