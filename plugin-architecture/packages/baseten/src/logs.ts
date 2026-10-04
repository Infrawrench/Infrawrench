import type { LogsFetchResult } from "@infrawrench/plugin-base";
import type { BasetenApi } from "./api.js";

/**
 * Log tails from the management API's logs endpoints (deployment,
 * environment, training job; spec verified 2026-10). Baseten defaults to the
 * last 30 minutes, which is empty for anything idle, so the tail is read
 * newest-first over the last 24 hours (the API allows up to 7 days) and
 * reversed into reading order.
 */

const WINDOW_MS = 24 * 3_600_000;
export const LOG_FILTERS = ["All levels", "Warnings and errors", "Errors only"];
const MIN_LEVEL: Record<string, string | undefined> = {
  "All levels": undefined,
  "Warnings and errors": "WARNING",
  "Errors only": "ERROR",
};

interface LogLine {
  timestamp?: string;
  message?: string;
  replica?: string | null;
  request_id?: string | null;
  level?: string | null;
}

/** Baseten log timestamps are epoch nanoseconds, as a string. */
export function formatLogLine(l: LogLine): string {
  const ns = Number(l.timestamp);
  const iso = Number.isFinite(ns) ? new Date(Math.floor(ns / 1e6)).toISOString() : "";
  const parts = [iso, l.level ?? "", l.replica ? `[${l.replica}]` : ""].filter(Boolean);
  return `${parts.join(" ")} ${l.message ?? ""}`.trimStart();
}

export async function fetchLogs(
  api: BasetenApi,
  path: string,
  tailLines: number | undefined,
  filter: string | undefined,
): Promise<LogsFetchResult> {
  const active = filter && LOG_FILTERS.includes(filter) ? filter : LOG_FILTERS[0]!;
  const end = Date.now();
  const res = await api.request<{ logs?: LogLine[] }>(path, {
    query: {
      start_epoch_millis: end - WINDOW_MS,
      end_epoch_millis: end,
      direction: "desc",
      limit: Math.min(1000, Math.max(1, tailLines ?? 200)),
      min_level: MIN_LEVEL[active],
    },
  });
  const lines = (res?.logs ?? []).map(formatLogLine).reverse();
  return {
    text: lines.map((l) => `${l}\n`).join(""),
    containers: LOG_FILTERS,
    activeContainer: active,
  };
}
