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
 *   429 a rate limit, retried with the same `requestId` and `retry=true`. The
 *   reference allows retrying 429, 503 and 504 with backoff on the GETs too.
 * - Values arrive as strings: numbers in decimal, booleans as "true"/"false",
 *   DATE as days since the epoch, TIMESTAMP_* as seconds since the epoch with
 *   nine decimals (TIMESTAMP_TZ followed by a space and the offset).
 *
 * Every statement runs with session `TIMEZONE = UTC` (the ACCOUNT_USAGE docs
 * ask for it when reconciling with ORGANIZATION_USAGE) and `QUERY_TAG =
 * infrawrench`, so the plugin's own queries are attributable in Snowflake.
 *
 * Paths, the statement body and the answers are typed from Snowflake's OpenAPI
 * document (`plugingen.json`). Answers are read as text because a body that is
 * not JSON is not a failure here, and a host service is always asked for bytes
 * so that gzip partitions survive it.
 */

import {
  ListTruncatedError,
  createApiClient,
  pathEncode,
  requireListPage,
  restRequest,
  type ApiBody,
  type HttpHostServices,
  type RestRequestOptions,
} from "@infrawrench/plugin-base";
import type { SnowflakeAccount } from "./account.js";
import type { components, operations, paths } from "./api-types.gen.js";
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
  /**
   * The rows are stored or acted on as the whole answer, so throw rather than
   * answer with part of them: past `maxRows`, or on a 200 that holds no rows
   * without saying there are none.
   */
  everyRow?: boolean;
  /** Keep column names as Snowflake returns them instead of lower-casing them. */
  keepColumnCase?: boolean;
  /**
   * Positional bind variables for `?` placeholders, keyed "1", "2", ... The
   * SQL API takes every value as a string (or null) with a Snowflake type.
   * Not allowed together with `multiStatementCount`: the SQL API does not
   * support binding in multi-statement requests.
   */
  bindings?: Record<string, SnowflakeBinding>;
  /**
   * Run a semicolon-separated batch of statements (`MULTI_STATEMENT_COUNT`).
   * Needed for an explicit `BEGIN ... COMMIT` transaction, because every SQL
   * API request is its own session. 0 accepts any number of statements.
   */
  multiStatementCount?: number;
  /**
   * Extra session parameters, merged over the defaults (`timezone`,
   * `query_tag`). Only the SQL API's allowlisted parameters are accepted.
   */
  parameters?: Record<string, string | number>;
  /** Aborts the request; a running statement is cancelled best-effort. */
  signal?: AbortSignal;
}

/** One SQL API bind value. */
export interface SnowflakeBinding {
  type: "TEXT" | "FIXED" | "REAL" | "BOOLEAN" | "DATE" | "TIMESTAMP_NTZ" | "TIMESTAMP_TZ";
  value: string | null;
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

/**
 * The SQL answer that says this role may not read the object. Unlike
 * {@link isNotAuthorized} it leaves out a 401 or 403, which say the connection
 * failed and nothing about what is there, so only this one can mean "list none".
 */
export function isPrivilegeDenied(err: unknown): boolean {
  return (
    err instanceof SnowflakeError &&
    err.status !== 401 &&
    err.status !== 403 &&
    isNotAuthorized(err)
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
    const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

interface RawResponse {
  status: number;
  text: string;
}

/**
 * Every answer has the fields `runSql` reads in `ResultSet`, with all of them
 * optional: the document's `QueryStatus` (202) and `QueryFailureStatus` (422) are
 * the same fields, and an error body is whatever a gateway sent.
 */
type ResultSetBody = components["schemas"]["ResultSet"];

/** The one route the client cannot express: see {@link submit}. */
const STATEMENTS = "/api/v2/statements" satisfies keyof paths;

/** A non-2xx answer on its way to {@link answerOf}: `runSql` retries and polls on the status. */
class NonSuccessAnswer extends Error {
  constructor(readonly answer: RawResponse) {
    super(`Snowflake answered ${answer.status}`);
  }
}

/** Partitions come back gzip-encoded; ask the host for bytes so they survive. */
function binaryAwareHttp(http: HttpHostServices): HttpHostServices {
  return {
    request: async (req) => {
      const res = await http.request({ ...req, responseEncoding: "binary" });
      return res.rawBody ? { ...res, body: await gunzipIfNeeded(res.rawBody) } : res;
    },
  };
}

function transportOf(
  ctx: SnowflakeContext,
): Pick<RestRequestOptions, "http" | "caCert" | "contentType" | "httpError"> {
  return {
    ...(ctx.http ? { http: binaryAwareHttp(ctx.http) } : {}),
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    contentType: "with-body",
    httpError: ({ status, body }) => new NonSuccessAnswer({ status, text: body }),
  };
}

async function headersOf(ctx: SnowflakeContext): Promise<Record<string, string>> {
  return {
    ...(await ctx.auth.headers()),
    Accept: "application/json",
    "User-Agent": "Infrawrench/1.0",
  };
}

function apiOf(ctx: SnowflakeContext) {
  return createApiClient<paths>({
    vendor: "Snowflake",
    baseUrl: `https://${ctx.account.host}`,
    headers: () => headersOf(ctx),
    emptyBodyIsUndefined: true,
    ...transportOf(ctx),
  });
}

/**
 * `POST /api/v2/statements`, on `restRequest` because `api.post` answers with the
 * body alone and a 202 is not a 200. The query is written here too: `retry` is only
 * in the prose reference, not the document.
 */
async function submit(
  ctx: SnowflakeContext,
  query: string,
  body: ApiBody<operations["SubmitStatement"]>,
  signal: AbortSignal | undefined,
) {
  return restRequest<string>({
    vendor: "Snowflake",
    url: `https://${ctx.account.host}${STATEMENTS}${query}`,
    headers: { ...(await headersOf(ctx)), "Content-Type": "application/json" },
    init: { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) },
    responseAs: "text",
    ...transportOf(ctx),
  });
}

/** Sends one request and answers with its status and text, whatever the status. */
async function answerOf(
  signal: AbortSignal | undefined,
  call: () => Promise<{ status: number; body: string }>,
): Promise<RawResponse> {
  if (signal?.aborted) throw new SnowflakeError("Snowflake: the request was cancelled.", 499);
  try {
    const { status, body } = await call();
    return { status, text: body };
  } catch (err) {
    if (err instanceof NonSuccessAnswer) return err.answer;
    throw err;
  }
}

const RETRIED_STATUSES = new Set([429, 503, 504]);
const ATTEMPTS = 4;

/** {@link answerOf}, sending again with backoff while Snowflake says to come back later. */
async function answerWithRetries(
  signal: AbortSignal | undefined,
  call: (attempt: number) => Promise<{ status: number; body: string }>,
): Promise<RawResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await answerOf(signal, () => call(attempt));
    if (!RETRIED_STATUSES.has(res.status) || attempt === ATTEMPTS - 1) return res;
    await sleep(1000 * 2 ** attempt);
  }
}

function parseBody(res: RawResponse): ResultSetBody {
  if (!res.text) return {};
  try {
    return JSON.parse(res.text);
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
  const body: ApiBody<operations["SubmitStatement"]> = {
    statement,
    timeout,
    ...(warehouse ? { warehouse } : {}),
    ...(role ? { role } : {}),
    ...(opts.database ? { database: opts.database } : {}),
    ...(opts.schema ? { schema: opts.schema } : {}),
    ...(opts.bindings ? { bindings: opts.bindings } : {}),
    parameters: {
      timezone: "UTC",
      query_tag: QUERY_TAG,
      ...(opts.multiStatementCount !== undefined
        ? { MULTI_STATEMENT_COUNT: String(opts.multiStatementCount) }
        : {}),
      ...opts.parameters,
    },
  };
  if (opts.bindings && opts.multiStatementCount !== undefined) {
    throw new Error("Snowflake: bind variables are not supported in multi-statement requests.");
  }
  const signal = opts.signal;
  const withSignal = signal ? { signal } : {};
  const api = apiOf(ctx);
  const requestId = uuid();
  const place = { vendor: "Snowflake", path: statement.replace(/\s+/g, " ").trim().slice(0, 80) };

  const res = await answerWithRetries(signal, (attempt) =>
    submit(ctx, `?requestId=${requestId}${attempt > 0 ? "&retry=true" : ""}`, body, signal),
  );
  let parsed = parseBody(res);
  let status = res.status;
  let statementHandle = parsed.statementHandle;

  // Still running: poll the statement until it finishes.
  const started = Date.now();
  let delay = 500;
  while (status === 202) {
    const handle = statementHandle;
    if (!handle) throw new SnowflakeError("Snowflake: statement accepted without a handle.", 202);
    if (Date.now() - started > Math.max(MAX_POLL_MS, timeout * 1000)) {
      throw new SnowflakeError("Snowflake: gave up waiting for the statement to finish.", 408);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
    // Best effort: stop the warehouse work the caller no longer wants.
    const cancel = () =>
      api.post(`/api/v2/statements/${pathEncode(handle)}/cancel`).catch(() => undefined);
    if (signal?.aborted) {
      await cancel();
      throw new SnowflakeError("Snowflake: the statement was cancelled.", 499);
    }
    const poll = await answerWithRetries(signal, () =>
      api.getText(`/api/v2/statements/${pathEncode(handle)}`, withSignal),
    ).catch(async (err: unknown) => {
      if (signal?.aborted) await cancel();
      throw err;
    });
    status = poll.status;
    parsed = parseBody(poll);
    statementHandle = parsed.statementHandle ?? statementHandle;
    if (status !== 200 && status !== 202) throw errorFor(poll, parsed);
  }
  if (status !== 200) throw errorFor(res, parsed);

  const columns: ColumnMeta[] = (parsed.resultSetMetaData?.rowType ?? []).map((c) => ({
    name: c.name,
    type: c.type,
    ...(typeof c.scale === "number" ? { scale: c.scale } : {}),
  }));
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const keepCase = opts.keepColumnCase === true;
  // `data` is optional in the document, and neither it nor the reference says what a
  // result with no rows sends, so that one case is told apart by the row count.
  const firstPage =
    opts.everyRow && parsed.resultSetMetaData?.numRows !== 0
      ? requireListPage(parsed.data, { ...place, key: "data", page: parsed })
      : (parsed.data ?? []);
  const rows = toRows(firstPage, columns, keepCase);
  const partitionInfo = parsed.resultSetMetaData?.partitionInfo;
  const partitions = partitionInfo?.length ?? 1;
  let truncated = false;
  for (let p = 1; p < partitions; p++) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const handle = statementHandle;
    if (!handle) {
      throw new SnowflakeError(
        `Snowflake: the result has ${partitions} partitions and no statement handle to read them by.`,
        status,
      );
    }
    const part = await answerWithRetries(signal, () =>
      api.getText(`/api/v2/statements/${pathEncode(handle)}`, {
        query: { partition: p },
        ...withSignal,
      }),
    );
    const partBody = parseBody(part);
    if (part.status !== 200) throw errorFor(part, partBody);
    const partRows =
      partitionInfo?.[p]?.rowCount === 0
        ? (partBody.data ?? [])
        : requireListPage(partBody.data, { ...place, key: "data", page: partBody });
    for (const row of toRows(partRows, columns, keepCase)) rows.push(row);
  }
  if (rows.length > maxRows) {
    rows.length = maxRows;
    truncated = true;
  }
  if (truncated && opts.everyRow) {
    throw new ListTruncatedError({ ...place, items: rows.length, maxItems: maxRows });
  }
  return {
    columns,
    rows,
    truncated,
    ...(statementHandle ? { statementHandle } : {}),
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
