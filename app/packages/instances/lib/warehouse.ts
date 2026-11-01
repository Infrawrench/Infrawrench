import { env } from "cloudflare:workers";
import { QueryError, checkSql } from "./chat/sql";
import type { Cell, QueryResult } from "./chat/types";

export { QueryError };

/**
 * Read-only queries against the AWS pricing warehouse (ClickHouse; the tables
 * are `@infrawrench/server-core/aws-pricing-warehouse/schema`, loaded by the
 * bulk pricing sync). The token is read-only on the server side, which is the
 * real boundary: the chat runs whatever SELECT the model writes. The checks
 * here only turn obvious mistakes into readable errors and keep a huge result
 * out of the Worker's memory.
 */

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
  // Arrays, maps and tuples are shown as JSON.
  return JSON.stringify(value);
}

/** One JSON row; an exception thrown mid-stream arrives as a line of plain text instead. */
function parseLine(line: string): unknown[] {
  try {
    const row = JSON.parse(line) as unknown;
    if (Array.isArray(row)) return row;
  } catch {
    // fall through
  }
  throw new QueryError(line.replace(/\s*\(version [^)]*\)\s*$/, "").slice(0, 1500));
}

/**
 * Run a query; at most `maxRows` rows come back (`truncated` says whether
 * there were more), read as a stream and cut off there.
 */
export async function query(
  raw: string,
  { maxRows = 500, timeoutMs = 25_000 }: { maxRows?: number; timeoutMs?: number } = {},
): Promise<QueryResult> {
  const sql = checkSql(raw);
  const base = env.PRICING_WAREHOUSE_URL;
  const token = env.PRICING_WAREHOUSE_READ_TOKEN;
  if (!base || !token) throw new QueryError("The pricing warehouse is not configured.");
  const url = new URL(base);
  url.searchParams.set("default_format", "JSONCompactEachRowWithNamesAndTypes");
  // CloudHouse fails a read whose table changed under it repeatedly ("The
  // catalog changed during the query"), which happens while the sync swaps
  // partitions in; a moment later the same query works.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
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
    // ClickHouse's own message ("Code: 47. DB::Exception: Unknown identifier ...")
    // is what the model needs to fix its query.
    throw new QueryError(
      text.replace(/\s*\(version [^)]*\)\s*$/, "").slice(0, 1500) || `HTTP ${res.status}`,
    );
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
