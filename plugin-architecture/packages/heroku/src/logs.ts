import type { LogsFetchResult } from "@infrawrench/plugin-base";
import type { HerokuApi } from "./api.js";
import { enc } from "./kit.js";

/**
 * Logs through a log session: `POST /apps/{app}/log-sessions` with
 * `{lines, source, dyno_name, tail: false}` returns a one-off `logplex_url`
 * whose body is the requested tail as plain text (up to 1,500 lines).
 */

export const LOG_SOURCES = ["All logs", "App logs", "Heroku logs", "Router logs"];

export async function fetchHerokuLogs(
  api: HerokuApi,
  appId: string,
  tailLines: number | undefined,
  filter: string | undefined,
  dynoName?: string,
): Promise<LogsFetchResult> {
  const active = filter && LOG_SOURCES.includes(filter) ? filter : LOG_SOURCES[0]!;
  const body: Record<string, unknown> = {
    lines: Math.min(1500, Math.max(1, tailLines ?? 200)),
    tail: false,
  };
  if (active === "App logs") body["source"] = "app";
  if (active === "Heroku logs") body["source"] = "heroku";
  if (active === "Router logs") {
    body["source"] = "heroku";
    body["dyno_name"] = "router";
  }
  if (dynoName && active !== "Router logs") body["dyno_name"] = dynoName;
  const session = await api.request<{ logplex_url: string }>(`/apps/${enc(appId)}/log-sessions`, {
    method: "POST",
    body,
  });
  const text = session?.logplex_url ? await api.fetchText(session.logplex_url) : "";
  return {
    text: text && !text.endsWith("\n") ? `${text}\n` : text,
    containers: LOG_SOURCES,
    activeContainer: active,
  };
}
