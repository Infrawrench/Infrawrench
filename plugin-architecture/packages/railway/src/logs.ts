import type { LogsFetchResult } from "@infrawrench/plugin-base";
import type { RailwayApi } from "./api.js";
import { Q_BUILD_LOGS, Q_DEPLOYMENT_LOGS, Q_HTTP_LOGS } from "./queries.js";
import type { RwHttpLog, RwLog } from "./types.js";

/**
 * Deployment logs (`deploymentLogs`), build logs (`buildLogs`) and HTTP
 * request logs (`httpLogs`) of one deployment, each limited by `limit`
 * (newest lines). The three streams are the Logs tab's selector.
 */

export const LOG_STREAMS = ["Deploy logs", "Build logs", "HTTP logs"];

export function formatLog(l: RwLog): string {
  const sev = l.severity ? l.severity.toUpperCase() : "";
  return `${[l.timestamp, sev].filter(Boolean).join(" ")} ${l.message}`;
}

export function formatHttpLog(l: RwHttpLog): string {
  return [
    l.timestamp,
    l.method ?? "",
    l.path ?? "",
    l.httpStatus !== undefined ? String(l.httpStatus) : "",
    l.totalDuration !== undefined ? `${l.totalDuration}ms` : "",
    l.srcIp ?? "",
    l.edgeRegion ? `[${l.edgeRegion}]` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function fetchRailwayLogs(
  api: RailwayApi,
  deploymentId: string,
  tailLines: number | undefined,
  stream: string | undefined,
): Promise<LogsFetchResult> {
  const active = stream && LOG_STREAMS.includes(stream) ? stream : LOG_STREAMS[0]!;
  const limit = Math.min(1000, Math.max(1, tailLines ?? 200));
  let lines: string[];
  if (active === "HTTP logs") {
    const r = await api.gql<{ httpLogs: RwHttpLog[] }>(Q_HTTP_LOGS, { id: deploymentId, limit });
    lines = (r.httpLogs ?? []).map(formatHttpLog);
  } else {
    const query = active === "Build logs" ? Q_BUILD_LOGS : Q_DEPLOYMENT_LOGS;
    const key = active === "Build logs" ? "buildLogs" : "deploymentLogs";
    const r = await api.gql<Record<string, RwLog[]>>(query, { id: deploymentId, limit });
    lines = (r[key] ?? []).map(formatLog);
  }
  return {
    text: lines.map((l) => `${l}\n`).join(""),
    containers: LOG_STREAMS,
    activeContainer: active,
  };
}
