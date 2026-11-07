import type { LogsFetchResult } from "@infrawrench/plugin-base";
import type { LogLevel, LogLine } from "./types.js";

/**
 * Log tails from the management API's logs endpoints (deployment,
 * environment, training job; spec verified 2026-10). Baseten defaults to the
 * last 30 minutes, which is empty for anything idle, so the tail is read
 * newest-first over the last 24 hours (the API allows up to 7 days) and
 * reversed into reading order.
 */

const WINDOW_MS = 24 * 3_600_000;
export const LOG_FILTERS = ["All levels", "Warnings and errors", "Errors only"];
const MIN_LEVEL: Record<string, LogLevel | undefined> = {
  "All levels": undefined,
  "Warnings and errors": "WARNING",
  "Errors only": "ERROR",
};

/** What a tail asks for, which any of the logs routes takes. */
export interface LogsQuery {
  start_epoch_millis: number;
  end_epoch_millis: number;
  direction: "desc";
  limit: number;
  min_level?: LogLevel;
}

/** Baseten log timestamps are epoch nanoseconds, as a string. */
export function formatLogLine(l: LogLine): string {
  const ns = Number(l.timestamp);
  const iso = Number.isFinite(ns) ? new Date(Math.floor(ns / 1e6)).toISOString() : "";
  const parts = [iso, l.level ?? "", l.replica ? `[${l.replica}]` : ""].filter(Boolean);
  return `${parts.join(" ")} ${l.message ?? ""}`.trimStart();
}

export async function fetchLogs(
  read: (query: LogsQuery) => Promise<{ logs?: LogLine[] }>,
  tailLines: number | undefined,
  filter: string | undefined,
): Promise<LogsFetchResult> {
  const active = filter && LOG_FILTERS.includes(filter) ? filter : LOG_FILTERS[0]!;
  const end = Date.now();
  const minLevel = MIN_LEVEL[active];
  const res = await read({
    start_epoch_millis: end - WINDOW_MS,
    end_epoch_millis: end,
    direction: "desc",
    limit: Math.min(1000, Math.max(1, tailLines ?? 200)),
    ...(minLevel ? { min_level: minLevel } : {}),
  });
  const lines = (res?.logs ?? []).map(formatLogLine).reverse();
  return {
    text: lines.map((l) => `${l}\n`).join(""),
    containers: LOG_FILTERS,
    activeContainer: active,
  };
}
