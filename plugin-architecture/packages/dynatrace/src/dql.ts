import type { SqlTableMeta } from "@infrawrench/plugin-base";
import type { DynatraceContext } from "./api.js";
import { DynatraceApiError, platformFetch } from "./api.js";

/**
 * DQL against Grail through the Storage Query service
 * (`/platform/storage/query/v1/query:execute` and `query:poll`, the paths the
 * official `@dynatrace-sdk/client-query` calls). A query that finishes within
 * `requestTimeoutMilliseconds` answers `SUCCEEDED` with the result inline;
 * otherwise it answers `RUNNING` with a `requestToken` to poll.
 */

const QUERY_BASE = "/platform/storage/query/v1";
/** Most records a single editor run returns. Grail's own default is 1,000. */
export const MAX_RESULT_RECORDS = 1000;
const POLL_LIMIT = 30;

type QueryState = "NOT_STARTED" | "RUNNING" | "SUCCEEDED" | "RESULT_GONE" | "CANCELLED" | "FAILED";

interface QueryResponse {
  state?: QueryState;
  requestToken?: string;
  result?: {
    records?: Array<Record<string, unknown> | null>;
    metadata?: { grail?: { scannedBytes?: number; executionTimeMilliseconds?: number } };
  };
  error?: { message?: string; details?: { errorMessage?: string } };
}

export interface DqlOptions {
  maxResultRecords?: number;
  /** Override the query's own timeframe, ISO 8601. */
  defaultTimeframeStart?: string;
  defaultTimeframeEnd?: string;
}

function rowsOf(res: QueryResponse): Record<string, unknown>[] {
  return (res.result?.records ?? []).filter((r): r is Record<string, unknown> => r !== null);
}

export async function runDql(
  ctx: DynatraceContext,
  query: string,
  opts: DqlOptions = {},
): Promise<Record<string, unknown>[]> {
  const started = await platformFetch<QueryResponse>(ctx, `${QUERY_BASE}/query:execute`, {
    method: "POST",
    body: JSON.stringify({
      query,
      requestTimeoutMilliseconds: 10_000,
      maxResultRecords: opts.maxResultRecords ?? MAX_RESULT_RECORDS,
      ...(opts.defaultTimeframeStart ? { defaultTimeframeStart: opts.defaultTimeframeStart } : {}),
      ...(opts.defaultTimeframeEnd ? { defaultTimeframeEnd: opts.defaultTimeframeEnd } : {}),
    }),
  });
  let res = started;
  for (let i = 0; i < POLL_LIMIT && (res.state === "RUNNING" || res.state === "NOT_STARTED"); i++) {
    if (!res.requestToken) break;
    res = await platformFetch<QueryResponse>(ctx, `${QUERY_BASE}/query:poll`, {
      query: { "request-token": res.requestToken, "request-timeout-milliseconds": 10_000 },
    });
  }
  if (res.state === "SUCCEEDED") return rowsOf(res);
  if (res.state === "RUNNING" || res.state === "NOT_STARTED") {
    throw new DynatraceApiError(
      504,
      "The DQL query is still running after five minutes. Narrow the timeframe or add a limit.",
    );
  }
  const detail = res.error?.details?.errorMessage ?? res.error?.message;
  throw new DynatraceApiError(
    400,
    `DQL query ${String(res.state ?? "failed").toLowerCase()}${detail ? `: ${detail}` : ""}`,
  );
}

/**
 * What the SQL editor's sidebar lists. Grail data objects are fetched by name
 * (`fetch logs`, `fetch dt.entity.host`), and their fields are open-ended, so
 * the list is the documented data objects without columns.
 */
export const DQL_TABLES: SqlTableMeta[] = [
  "logs",
  "events",
  "bizevents",
  "spans",
  "dt.davis.problems",
  "dt.davis.events",
  "security.events",
  "user.events",
  "dt.system.events",
  "dt.entity.host",
  "dt.entity.service",
  "dt.entity.process_group",
  "dt.entity.application",
  "dt.entity.kubernetes_cluster",
].map((name) => ({ name, columns: [] }));

export const DEFAULT_DQL = "fetch logs\n| sort timestamp desc\n| limit 100";
