/**
 * The SQL API v2 transport: every call this plugin makes is a SQL statement
 * sent to `POST https://<account>.snowflakecomputing.com/api/v2/statements`,
 * so no native driver is needed anywhere (desktop renderer, server, poller).
 *
 * Verified against the SQL API reference, "Submitting a request" and
 * "Handling responses" (docs.snowflake.com/en/developer-guide/sql-api,
 * 2026-10):
 *
 * - 200 returns a ResultSet: `resultSetMetaData.rowType` (column `name`,
 *   `type`, `scale`), `resultSetMetaData.partitionInfo` (one entry per
 *   partition), and `data` as arrays of strings or null. Further partitions
 *   are `GET /api/v2/statements/{handle}?partition=N`, gzip-encoded and
 *   without metadata.
 * - 202 means still running; the body carries `statementHandle` and
 *   `statementStatusUrl`, polled with GET until it turns into a 200.
 * - 422 is a SQL error with `code`, `message` and `sqlState`; 408 a timeout;
 *   429 a rate limit, retried with the same `requestId` and `retry=true`.
 * - Values arrive as strings: numbers in decimal, booleans as "true"/"false",
 *   DATE as days since the epoch, TIMESTAMP_* as seconds since the epoch with
 *   nine decimals (TIMESTAMP_TZ followed by a space and the offset).
 *
 * Every statement runs with session `TIMEZONE = UTC` (the ACCOUNT_USAGE docs
 * ask for it when reconciling with ORGANIZATION_USAGE) and `QUERY_TAG =
 * infrawrench`, so the plugin's own queries are attributable in Snowflake.
 */

import type { HttpHostServices } from "@infrawrench/plugin-base";
import type { SnowflakeAccount } from "./account.js";
import type { SnowflakeAuth } from "./auth.js";

export interface SnowflakeContext {
  account: SnowflakeAccount;
  auth: SnowflakeAuth;
  /** Role statements run as; empty means the user's default role. */
  role?: string;
  /** Warehouse statements run on; empty means the user's default warehouse. */
  warehouse?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export interface StatementOptions {
  warehouse?: string;
  role?: string;
  database?: string;
  schema?: string;
  /** Server-side timeout in seconds. */
  timeoutSec?: number;
  /** Stop reading partitions once this many rows are in hand. */
  maxRows?: number;
  /** Keep column names as Snowflake returns them instead of lower-casing them. */
  keepColumnCase?: boolean;
}

export interface ColumnMeta {
  name: string;
  type: string;
  scale?: number;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  /** True when `maxRows` cut the result short. */
  truncated: boolean;
  statementHandle?: string;
}

export const QUERY_TAG = "infrawrench";
const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MAX_ROWS = 50_000;
const MAX_POLL_MS = 10 * 60_000;

/** A failed statement or request, with Snowflake's own code when it sent one. */
export class SnowflakeError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly sqlState: string | undefined;

  constructor(message: string, status: number, code?: string, sqlState?: string) {
    super(message);
    this.name = "SnowflakeError";
    this.status = status;
    this.code = code;
    this.sqlState = sqlState;
  }
}

/**
 * True for "the role cannot see this": the object is missing or the role has
 * no privilege on it (002003, the generic "does not exist or not
 * authorized"), insufficient privileges (003001), or an auth failure. Callers
 * use it to fall back (organization usage to account usage) or to list empty.
 */
export function isNotAuthorized(err: unknown): boolean {
  if (!(err instanceof SnowflakeError)) return false;
  if (err.status === 401 || err.status === 403) return true;
  if (err.code === "002003" || err.code === "003001" || err.code === "002037") return true;
  return /does not exist or not authorized|insufficient privileges|not authorized/i.test(
    err.message,
  );
}

/** Quote an identifier for SQL: `"name"` with embedded quotes doubled. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a dotted path of identifiers. */
export function qualified(...parts: string[]): string {
  return parts.map(ident).join(".");
}

/** Single-quoted string literal with embedded quotes and backslashes escaped. */
export function literal(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function uuid(): string {
  return crypto.randomUUID();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gunzipIfNeeded(bytes: Uint8Array): Promise<string> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

interface RawResponse {
  status: number;
  text: string;
}

async function send(
  ctx: SnowflakeContext,
  method: "GET" | "POST",
  pathAndQuery: string,
  body?: unknown,
): Promise<RawResponse> {
  const url = `https://${ctx.account.host}${pathAndQuery}`;
  const headers: Record<string, string> = {
    ...(await ctx.auth.headers()),
    Accept: "application/json",
    "User-Agent": "Infrawrench/1.0",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      // Partitions come back gzip-encoded; ask for bytes so they survive.
      responseEncoding: "binary",
    });
    const text = res.rawBody ? await gunzipIfNeeded(res.rawBody) : res.body;
    return { status: res.status, text };
  }
  const res = await fetch(url, {
    method,
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  });
  return { status: res.status, text: await res.text() };
}

interface ResultSetBody {
  code?: string;
  sqlState?: string;
  message?: string;
  statementHandle?: string;
  statementStatusUrl?: string;
  resultSetMetaData?: {
    numRows?: number;
    rowType?: Array<{ name: string; type: string; scale?: number | null }>;
    partitionInfo?: Array<{ rowCount?: number }>;
  };
  data?: Array<Array<string | null>>;
}

function parseBody(res: RawResponse): ResultSetBody {
  if (!res.text) return {};
  try {
    return JSON.parse(res.text) as ResultSetBody;
  } catch {
    return { message: res.text.slice(0, 500) };
  }
}

function errorFor(res: RawResponse, body: ResultSetBody): SnowflakeError {
  if (res.status === 401) {
    return new SnowflakeError(
      `Snowflake rejected the credentials (401): ${body.message ?? "check the account identifier, user and key or token"}.`,
      401,
      body.code,
    );
  }
  if (res.status === 403) {
    return new SnowflakeError(
      `Snowflake refused the request (403): ${body.message ?? "a network policy or role restriction may be blocking it"}.`,
      403,
      body.code,
    );
  }
  if (res.status === 408) {
    return new SnowflakeError("Snowflake: the statement timed out.", 408, body.code);
  }
  return new SnowflakeError(
    `Snowflake: ${body.message ?? `request failed with status ${res.status}`}`,
    res.status,
    body.code,
    body.sqlState,
  );
}

/** Snowflake cell (always a string or null) to a JS value, by column type. */
export function decodeCell(value: string | null, column: ColumnMeta): unknown {
  if (value === null) return null;
  const type = column.type.toLowerCase();
  switch (type) {
    case "fixed": {
      if ((column.scale ?? 0) > 0) return Number(value);
      const n = Number(value);
      return Number.isSafeInteger(n) ? n : value;
    }
    case "real":
      return Number(value);
    case "boolean":
      return value.toLowerCase() === "true";
    case "date": {
      const days = Number(value);
      return Number.isFinite(days) ? new Date(days * 86_400_000).toISOString().slice(0, 10) : value;
    }
    case "time": {
      const secs = Number(value);
      if (!Number.isFinite(secs)) return value;
      return new Date(secs * 1000).toISOString().slice(11, 19);
    }
    case "timestamp_ltz":
    case "timestamp_ntz":
    case "timestamp_tz": {
      const secs = Number(value.split(" ")[0]);
      return Number.isFinite(secs) ? new Date(Math.round(secs * 1000)).toISOString() : value;
    }
    default:
      return value;
  }
}

function toRows(
  data: Array<Array<string | null>>,
  columns: ColumnMeta[],
  keepCase: boolean,
): Record<string, unknown>[] {
  const keys = columns.map((c) => (keepCase ? c.name : c.name.toLowerCase()));
  return data.map((row) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++)
      out[keys[i]!] = decodeCell(row[i] ?? null, columns[i]!);
    return out;
  });
}

/**
 * Runs one SQL statement and returns every row (up to `maxRows`), decoded.
 * Keys are lower-cased unless `keepColumnCase` is set, so callers read SHOW
 * output (`"name"`) and SELECT aliases (`NAME`) the same way.
 */
export async function runSql(
  ctx: SnowflakeContext,
  statement: string,
  opts: StatementOptions = {},
): Promise<QueryResult> {
  const warehouse = opts.warehouse ?? ctx.warehouse;
  const role = opts.role ?? ctx.role;
  const timeout = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const body = {
    statement,
    timeout,
    ...(warehouse ? { warehouse } : {}),
    ...(role ? { role } : {}),
    ...(opts.database ? { database: opts.database } : {}),
    ...(opts.schema ? { schema: opts.schema } : {}),
    parameters: { timezone: "UTC", query_tag: QUERY_TAG },
  };
  const requestId = uuid();

  let res: RawResponse | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const retry = attempt > 0 ? "&retry=true" : "";
    res = await send(ctx, "POST", `/api/v2/statements?requestId=${requestId}${retry}`, body);
    if (res.status !== 429 && res.status !== 503 && res.status !== 504) break;
    await sleep(1000 * 2 ** attempt);
  }
  let parsed = parseBody(res!);
  let status = res!.status;

  // Still running: poll the statement until it finishes.
  const started = Date.now();
  let delay = 500;
  while (status === 202) {
    const handle = parsed.statementHandle;
    if (!handle) throw new SnowflakeError("Snowflake: statement accepted without a handle.", 202);
    if (Date.now() - started > Math.max(MAX_POLL_MS, timeout * 1000)) {
      throw new SnowflakeError("Snowflake: gave up waiting for the statement to finish.", 408);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
    const poll = await send(ctx, "GET", `/api/v2/statements/${encodeURIComponent(handle)}`);
    status = poll.status;
    parsed = parseBody(poll);
    if (status !== 200 && status !== 202) throw errorFor(poll, parsed);
  }
  if (status !== 200) throw errorFor(res!, parsed);

  const columns: ColumnMeta[] = (parsed.resultSetMetaData?.rowType ?? []).map((c) => ({
    name: c.name,
    type: c.type,
    ...(typeof c.scale === "number" ? { scale: c.scale } : {}),
  }));
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const keepCase = opts.keepColumnCase === true;
  const rows = toRows(parsed.data ?? [], columns, keepCase);
  const partitions = parsed.resultSetMetaData?.partitionInfo?.length ?? 1;
  let truncated = false;
  for (let p = 1; p < partitions; p++) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const handle = parsed.statementHandle;
    if (!handle) break;
    const part = await send(
      ctx,
      "GET",
      `/api/v2/statements/${encodeURIComponent(handle)}?partition=${p}`,
    );
    const partBody = parseBody(part);
    if (part.status !== 200) throw errorFor(part, partBody);
    rows.push(...toRows(partBody.data ?? [], columns, keepCase));
  }
  if (rows.length > maxRows) {
    rows.length = maxRows;
    truncated = true;
  }
  return {
    columns,
    rows,
    truncated,
    ...(parsed.statementHandle ? { statementHandle: parsed.statementHandle } : {}),
  };
}

// --- Row readers --------------------------------------------------------------

export const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "y" || s === "yes") return true;
  if (s === "false" || s === "n" || s === "no") return false;
  return undefined;
}
