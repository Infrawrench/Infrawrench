/**
 * Read-only queries against the AWS pricing warehouse (ClickHouse on
 * CloudHouse; tables in `./schema.ts`), shared by instances.infrawrench.com's
 * chat and the web API's `POST /api/v1/aws-pricing/query`.
 *
 * The token is read-only on the warehouse side, which is the real boundary.
 * `checkSql` only turns obvious mistakes into readable errors, and `query`
 * reads the result as a stream and stops at `maxRows`, so a huge result never
 * reaches the caller's memory. Plain `fetch` and web streams only: it runs in
 * a Worker as well as on Node.
 */

/** The warehouse's public endpoint; the token is what grants access. */
export const DEFAULT_WAREHOUSE_URL = "https://instances-clickhouse.infrawrench.com/";

/** The most rows one API query returns (`POST /api/v1/aws-pricing/query`). */
export const MAX_QUERY_ROWS = 10_000;

export type Cell = string | number | boolean | null;

export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: Cell[][];
  /** More rows matched than were returned. */
  truncated: boolean;
}

export interface WarehouseConfig {
  url?: string | undefined;
  /** A read-only bearer token. */
  token: string;
  fetch?: typeof fetch;
}

/** A query the warehouse (or `checkSql`) refused, with a message meant for its author. */
export class QueryError extends Error {}

/** The warehouse could not answer (a Cloudflare error page, a gateway error): not the query's fault. */
export class WarehouseUnavailableError extends Error {}

const STATEMENT =
  /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(select|with|describe|desc|show|explain)\b/i;

/** The statement as it will be sent, or a `QueryError` saying why not. */
export function checkSql(raw: string): string {
  const sql = raw.trim().replace(/;+\s*$/, "");
  if (!sql) throw new QueryError("The query is empty.");
  if (sql.length > 20_000) throw new QueryError("The query is too long.");
  if (!STATEMENT.test(sql)) {
    throw new QueryError("Only SELECT, WITH, DESCRIBE, SHOW and EXPLAIN queries can run.");
  }
  if (/;\s*\S/.test(sql.replace(/'(?:[^'\\]|\\.)*'/g, "''"))) {
    throw new QueryError("Send one statement at a time.");
  }
  if (/\bFORMAT\s+[A-Za-z]+\s*$/i.test(sql)) {
    throw new QueryError("Leave out FORMAT; results come back as JSON.");
  }
  if (/\bSETTINGS\b/i.test(sql)) {
    throw new QueryError("SETTINGS cannot be changed on this read-only connection.");
  }
  return sql;
}

/** ClickHouse quotes 64-bit integers and decimals in JSON; numbers are numbers here. */
function isNumeric(type: string): boolean {
  return /^(?:Nullable\()?(?:LowCardinality\()?(?:U?Int\d+|Float\d+|Decimal)/.test(type);
}

function cell(value: unknown, numeric: boolean): Cell {
  if (value === null || value === undefined) return null;
  if (numeric && typeof value === "string" && value !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  // Arrays, maps and tuples are returned as JSON text.
  return JSON.stringify(value);
}

/** ClickHouse's message without its trailing version note. */
const tidy = (text: string) => text.replace(/\s*\(version [^)]*\)\s*$/, "").slice(0, 1500);

/** One JSON row; an exception thrown mid-stream arrives as a line of plain text instead. */
function parseLine(line: string): unknown[] {
  try {
    const row = JSON.parse(line) as unknown;
    if (Array.isArray(row)) return row;
  } catch {
    // fall through
  }
  throw new QueryError(tidy(line));
}

/**
 * Run a query; at most `maxRows` rows come back (`truncated` says whether
 * there were more), read as a stream and cut off there.
 */
export async function queryWarehouse(
  raw: string,
  config: WarehouseConfig,
  { maxRows = 500, timeoutMs = 25_000 }: { maxRows?: number; timeoutMs?: number } = {},
): Promise<QueryResult> {
  const sql = checkSql(raw);
  const doFetch = config.fetch ?? fetch;
  const url = new URL(config.url || DEFAULT_WAREHOUSE_URL);
  url.searchParams.set("default_format", "JSONCompactEachRowWithNamesAndTypes");
  // CloudHouse fails a read whose table changed under it repeatedly ("The
  // catalog changed during the query"), which happens while the sync swaps
  // partitions in; a moment later the same query works.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      body: sql,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok || attempt >= 2) break;
    const text = await res
      .clone()
      .text()
      .catch(() => "");
    if (!/catalog changed during the query/i.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  if (!res.ok || !res.body) {
    const text = (await res.text().catch(() => "")).trim();
    if (
      res.status >= 502 ||
      /^<!DOCTYPE html|^error code: \d+/i.test(text) ||
      /catalog changed during the query/i.test(text)
    ) {
      const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1];
      throw new WarehouseUnavailableError(
        `warehouse: HTTP ${res.status} ${title ?? text.slice(0, 200)}`,
      );
    }
    // ClickHouse's own message ("Code: 47. DB::Exception: Unknown identifier
    // ...") is what the author needs to fix the query.
    throw new QueryError(tidy(text) || `HTTP ${res.status}`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const lines: unknown[][] = [];
  let truncated = false;
  // Two header lines (names, types), then one line per row.
  const limit = maxRows + 2;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += value;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        if (lines.length >= limit) {
          truncated = true;
          break;
        }
        lines.push(parseLine(line));
      }
      if (truncated || done) break;
    }
    if (!truncated && buffer.trim()) lines.push(parseLine(buffer));
  } finally {
    await reader.cancel().catch(() => {});
  }
  const [names = [], types = [], ...data] = lines;
  const columns = names.map((name, i) => ({ name: String(name), type: String(types[i] ?? "") }));
  const numeric = columns.map((c) => isNumeric(c.type));
  return {
    columns,
    rows: data.map((row) => row.map((v, i) => cell(v, numeric[i] ?? false))),
    truncated,
  };
}
