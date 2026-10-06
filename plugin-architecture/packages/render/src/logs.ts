import type { LogsFetchResult } from "@infrawrench/plugin-base";
import type { RenderApi } from "./api.js";
import type { RenderLogLine } from "./types.js";

/**
 * Log tails from `GET /logs` (verified 2026-10). The endpoint needs the
 * workspace id as `ownerId` and one or more `resource` ids (service, cron job,
 * one-off job, Postgres or Key Value). It pages by time window, newest first
 * with `direction=backward`, at most 100 lines a page, and is limited to 30
 * reads a minute, so a tail reads at most three pages.
 */

export const LOG_FILTERS = ["All logs", "Application", "Requests", "Builds"];
const TYPE_FOR: Record<string, string | undefined> = {
  "All logs": undefined,
  Application: "app",
  Requests: "request",
  Builds: "build",
};
const WINDOW_MS = 7 * 24 * 3_600_000;
const PAGE = 100;
const MAX_PAGES = 3;

export function formatLogLine(l: RenderLogLine): string {
  const label = (name: string) => l.labels?.find((x) => x.name === name)?.value ?? "";
  const level = label("level");
  const instance = label("instance");
  const parts = [
    l.timestamp ?? "",
    level ? level.toUpperCase() : "",
    instance ? `[${instance}]` : "",
  ];
  return `${parts.filter(Boolean).join(" ")} ${l.message ?? ""}`.trimStart();
}

export async function fetchRenderLogs(
  api: RenderApi,
  ownerId: string,
  resourceId: string,
  tailLines: number | undefined,
  filter: string | undefined,
  filters: string[] = LOG_FILTERS,
): Promise<LogsFetchResult> {
  const active = filter && filters.includes(filter) ? filter : filters[0]!;
  const want = Math.min(PAGE * MAX_PAGES, Math.max(1, tailLines ?? 200));
  const lines: RenderLogLine[] = [];
  let end = new Date().toISOString();
  let start = new Date(Date.now() - WINDOW_MS).toISOString();
  for (let page = 0; page < MAX_PAGES && lines.length < want; page++) {
    const res = await api.request<{
      hasMore?: boolean;
      nextStartTime?: string;
      nextEndTime?: string;
      logs?: RenderLogLine[];
    }>("/logs", {
      query: {
        ownerId,
        resource: [resourceId],
        direction: "backward",
        limit: Math.min(PAGE, want - lines.length),
        startTime: start,
        endTime: end,
        ...(TYPE_FOR[active] ? { type: [TYPE_FOR[active]!] } : {}),
      },
    });
    lines.push(...(res?.logs ?? []));
    if (!res?.hasMore || !res.nextEndTime || !res.nextStartTime) break;
    start = res.nextStartTime;
    end = res.nextEndTime;
  }
  const text = lines
    .slice(0, want)
    .reverse()
    .map((l) => `${formatLogLine(l)}\n`)
    .join("");
  return { text, containers: filters, activeContainer: active };
}
