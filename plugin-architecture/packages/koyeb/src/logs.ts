import type { LogsFetchResult } from "@infrawrench/plugin-base";
import type { KoyebApi } from "./api.js";

/**
 * `GET /v1/streams/logs/query` (verified 2026-10): `type` runtime or build,
 * one of service_id / deployment_id / instance_ids, `order=desc`, `limit`
 * up to 1,000, `start` defaulting to 15 minutes ago (so a day back is asked
 * for explicitly; retention depends on the plan).
 */

export const LOG_STREAMS = ["Runtime logs", "Build logs", "System logs"];

interface LogEntry {
  msg?: string;
  created_at?: string;
  labels?: Record<string, string>;
}

export function formatLog(e: LogEntry): string {
  const inst = e.labels?.["instance_id"] ? `[${e.labels["instance_id"]!.slice(0, 8)}]` : "";
  const stream = e.labels?.["stream"] && e.labels["stream"] !== "stdout" ? e.labels["stream"] : "";
  return `${[e.created_at ?? "", stream, inst].filter(Boolean).join(" ")} ${e.msg ?? ""}`.trimStart();
}

export async function fetchKoyebLogs(
  api: KoyebApi,
  scope: { service_id?: string; deployment_id?: string; instance_ids?: string[] },
  tailLines: number | undefined,
  stream: string | undefined,
): Promise<LogsFetchResult> {
  const active = stream && LOG_STREAMS.includes(stream) ? stream : LOG_STREAMS[0]!;
  const end = Date.now();
  const res = await api.request<{ data?: LogEntry[] }>("/v1/streams/logs/query", {
    query: {
      type: active === "Build logs" ? "build" : "runtime",
      ...scope,
      ...(active === "System logs" ? { streams: ["koyeb"] } : {}),
      ...(active === "Runtime logs" ? { streams: ["stdout", "stderr"] } : {}),
      start: new Date(end - 24 * 3_600_000).toISOString(),
      end: new Date(end).toISOString(),
      order: "desc",
      limit: String(Math.min(1000, Math.max(1, tailLines ?? 200))),
    },
  });
  const lines = (res?.data ?? []).map(formatLog).reverse();
  return {
    text: lines.map((l) => `${l}\n`).join(""),
    containers: LOG_STREAMS,
    activeContainer: active,
  };
}
