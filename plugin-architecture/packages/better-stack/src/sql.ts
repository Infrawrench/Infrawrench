/**
 * Telemetry's SQL API: a read-only ClickHouse HTTP endpoint per data region
 * (`https://<region>-connect.betterstackdata.com`), authenticated with the
 * username and password of a "connection" created through
 * `POST /api/v1/connections` (the password is only returned then). Tables are
 * named after the source: `remote(t<team>_<table>_logs)` for recent logs,
 * `s3Cluster(primary, t<team>_<table>_s3)` for older ones (`_row_type = 1`
 * logs, `3` spans) and `remote(t<team>_<table>_metrics)` for aggregates.
 * Verified against Better Stack's "SQL API" and Connection API docs, 2026-10.
 */
import type { BetterStackContext } from "./api.js";
import { BetterStackApiError } from "./api.js";

export interface SqlConnection {
  username: string;
  password: string;
  host?: string;
}

/** The SQL endpoint for a source's data region. */
export function sqlHost(dataRegion: string | undefined, fallback?: string): string {
  if (dataRegion && /^[a-z0-9-]+$/.test(dataRegion))
    return `https://${dataRegion}-connect.betterstackdata.com`;
  if (fallback && /^[a-z0-9.-]+\.betterstackdata\.com$/.test(fallback))
    return `https://${fallback}`;
  throw new Error(`Better Stack plugin: no SQL endpoint for data region "${dataRegion ?? ""}"`);
}

/** `t<team>_<table>`: the prefix every table of a source starts with. */
export function tablePrefix(teamId: string, tableName: string): string {
  return `t${teamId}_${tableName}`;
}

function basic(conn: SqlConnection): string {
  const raw = `${conn.username}:${conn.password}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/** Run SQL and return its rows (`FORMAT JSONEachRow` is appended when absent). */
export async function runSql(
  ctx: BetterStackContext,
  host: string,
  conn: SqlConnection,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  const body = /\bFORMAT\s+\w+\s*$/i.test(trimmed) ? trimmed : `${trimmed}\nFORMAT JSONEachRow`;
  const url = `${host}/?output_format_pretty_row_numbers=0`;
  const headers = { Authorization: basic(conn), "Content-Type": "text/plain" };
  let status: number;
  let text: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method: "POST",
      headers,
      body,
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, { method: "POST", headers, body });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) {
    throw new BetterStackApiError(
      status,
      `Better Stack SQL API error ${status}: ${text.slice(0, 500)}`,
    );
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return { raw: l };
      }
    });
}

export function logsSql(prefix: string, limit: number): string {
  return `SELECT dt, raw FROM (SELECT dt, raw FROM remote(${prefix}_logs) UNION ALL SELECT dt, raw FROM s3Cluster(primary, ${prefix}_s3) WHERE _row_type = 1) ORDER BY dt DESC LIMIT ${limit}`;
}

export function eventsSql(
  prefix: string,
  fromIso: string,
  toIso: string,
  bucketSeconds: number,
): string {
  const from = fromIso.replace("T", " ").replace(/\.\d+Z$|Z$/, "");
  const to = toIso.replace("T", " ").replace(/\.\d+Z$|Z$/, "");
  return `SELECT toStartOfInterval(dt, INTERVAL ${bucketSeconds} SECOND) AS time, countMerge(events_count) AS events FROM remote(${prefix}_metrics) WHERE dt >= toDateTime('${from}') AND dt <= toDateTime('${to}') GROUP BY time ORDER BY time`;
}

/** One log line from a `raw` JSON event. */
export function logLine(row: Record<string, unknown>): string {
  const dt = String(row["dt"] ?? "");
  const raw = row["raw"];
  let event: Record<string, unknown> | undefined;
  if (typeof raw === "string") {
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return `${dt}  ${raw}`;
    }
  } else if (raw && typeof raw === "object") {
    event = raw as Record<string, unknown>;
  }
  if (!event) return dt;
  const message = event["message"] ?? event["msg"] ?? event["body"];
  const level = event["level"] ?? event["severity"];
  if (typeof message === "string")
    return `${dt}  ${level ? `${String(level).toUpperCase()}  ` : ""}${message}`;
  return `${dt}  ${JSON.stringify(event)}`;
}
