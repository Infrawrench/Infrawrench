import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  withCursorPagination,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

/** Platform API v1. Spec: https://api.fal.ai/v1/openapi.json (Oct 2026). */
export const API_BASE = "https://api.fal.ai/v1";

export type ModelUsagePage = ApiResponse<operations["getUsage"]>;
export type ServerlessUsagePage = ApiResponse<operations["serverlessGetUsage"]>;
export type AnalyticsPage = ApiResponse<operations["getAnalytics"]>;
export type AnalyticsRow = NonNullable<AnalyticsPage["time_series"]>[number]["results"][number];
export type ModelInfo = ApiListItem<operations["getModels"], "models">;
export type ModelMetadata = NonNullable<ModelInfo["metadata"]>;
export type ModelPrice = ApiListItem<operations["getPricing"], "prices">;
export type ApiKey = ApiListItem<operations["listApiKeys"], "keys">;
export type App = ApiListItem<operations["serverlessListApps"], "apps">;
export type Instance = ApiResponse<operations["getComputeInstance"]>;
export type RequestItem = ApiListItem<operations["listRequestsByEndpoint"], "items">;
export type Revision = ApiListItem<operations["serverlessListAppRevisions"], "revisions">;

export type FalApi = ReturnType<typeof createFalApi>;

/**
 * The query as fal has always been sent it: an empty string is left out, which
 * the client's default would send, and an array repeats its key.
 */
function writeQuery(query: Record<string, ParamValue>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    for (const item of Array.isArray(value) ? value : [value]) out.append(key, String(item));
  }
  return out.toString();
}

export function createFalApi(apiKey: string, caCert: string, http: HttpHostServices | undefined) {
  const client = createApiClient<paths>({
    vendor: "fal",
    baseUrl: API_BASE,
    // fal uses `Key`, not `Bearer`.
    headers: { Authorization: `Key ${apiKey}`, Accept: "application/json" },
    http,
    caCert,
    serializeQuery: writeQuery,
    // The message names the path without its query, which the default would add.
    httpError: ({ status, path, body }) =>
      new Error(`fal API error ${status} for ${path}: ${body}`),
  });
  return withCursorPagination(client, {
    cursorParam: "cursor",
    next: "next_cursor",
    sizeParam: "limit",
    pageSize: 100,
    maxPages: 100,
    // The document: next_cursor is "null if no more pages", so only that ends a list.
    continueOnEmptyPage: true,
  });
}

export function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("status" in err)) return undefined;
  return typeof err.status === "number" ? err.status : undefined;
}

function withStatus(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const m = /API error (\d{3})\b/.exec(err.message);
  if (!m) return err;
  const status = Number(m[1]);
  const hint =
    status === 401
      ? " Check the key in the fal dashboard under API Keys."
      : status === 403
        ? " This key's permissions do not cover this call. The FULL preset covers everything Infrawrench does."
        : "";
  return Object.assign(new Error(`${err.message}${hint}`), { status });
}

/** Make one call, so that whatever it throws carries its status and a hint. */
export async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw withStatus(err);
  }
}

/** The query that asks for the page after `cursor`. Goes last in a call's query. */
export function afterCursor(cursor: string | undefined): { cursor?: string } {
  return cursor ? { cursor } : {};
}

/** A usage or analytics report: its rows sit under whichever `expand` asked for them. */
interface ReportPage {
  next_cursor?: string | null;
  time_series?: readonly object[];
  summary?: readonly object[];
}

/**
 * Every page of a report, which callers read whole because its rows are nested in
 * buckets. `partial` keeps what was read at the cap, for a chart.
 */
export async function allPages<T extends ReportPage>(
  fetchPage: (cursor: string | undefined) => Promise<T>,
  read: { path: string; key: "time_series" | "summary"; maxPages: number; partial?: boolean },
): Promise<T[]> {
  const out: T[] = [];
  let items = 0;
  let cursor: string | undefined;
  for (let i = 0; i < read.maxPages; i++) {
    const at = cursor;
    const page = await call(() => fetchPage(at));
    const rows = requireListPage(page[read.key], {
      vendor: "fal",
      path: read.path,
      key: read.key,
      page,
    });
    items += rows.length;
    out.push(page);
    if (!page.next_cursor) return out;
    cursor = page.next_cursor;
  }
  if (read.partial) return out;
  throw new ListTruncatedError({
    vendor: "fal",
    path: read.path,
    items,
    maxPages: read.maxPages,
  });
}
