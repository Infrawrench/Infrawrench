import {
  createApiClient,
  unencodedSegment,
  withCursorPagination,
  type ApiClientOptions,
  type HttpHostServices,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { paths as V2Paths } from "./api-types.v2.gen.js";
import type { paths as V3Paths } from "./api-types.v3.gen.js";

/**
 * CircleCI REST API v2 (https://circleci.com/docs/api/v2/, spec at
 * https://circleci.com/api/v2/openapi.json, verified 2026-10).
 *
 * Every request carries the personal API token in the `Circle-Token` header.
 * The self-hosted runner API lives on its own host
 * (`runner.circleci.com/api/v3`) and takes the same token and header; API v3
 * takes it as a Bearer token instead.
 *
 * Types come from each API's OpenAPI document (`../plugingen.json`). The runner
 * host publishes none, so {@link RunnerPaths} is written by hand. The v3 document
 * shows runner items as `{id}` alone; CircleCI's own CLI decodes `attributes` and
 * `references` on them (`internal/apiclient/runner.go`), so the document is short.
 * Those reads stay optional, and nothing depends on one that an id could do instead.
 */
export const API_BASE = "https://circleci.com/api/v2";
/**
 * API v3 (https://circleci.com/docs/api/v3/): the only documented way to list
 * an organization's projects and to manage runner resource classes and
 * tokens. Bearer auth only, `{data: …}` envelopes, `page[cursor]` paging.
 */
export const API_V3_BASE = "https://circleci.com/api/v3";
export const RUNNER_API_BASE = "https://runner.circleci.com/api/v3";
export const APP_BASE = "https://app.circleci.com";

/**
 * Everything a CircleCI request needs. Split out of the client so the cost
 * collector, the organization picker and the tests can run without one.
 */
export interface CircleContext {
  token: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class CircleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CircleApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof CircleApiError ? err.status : 0;
}

/** True for the answers that mean "this token may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/** A field of a body nobody has validated, or `undefined` if it is not an object. */
const fieldOf = (from: unknown, name: string): unknown =>
  typeof from === "object" && from !== null ? Reflect.get(from, name) : undefined;

function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const message = fieldOf(parsed, "message");
    if (typeof message === "string") return message;
    const error = fieldOf(parsed, "error");
    const detail = fieldOf(error, "detail");
    if (typeof detail === "string") return detail;
    const title = fieldOf(error, "title");
    if (typeof title === "string") return title;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return body.slice(0, 500);
}

/**
 * A project or organization slug for a path: each segment encoded, the slashes
 * kept because they are part of the route. A slug the API hands out comes through
 * as it was; a hand-entered one holding `?`, `#` or a space stays on its route, and
 * one with an empty or dot segment, which would land on another route, is refused.
 */
export function slugSegment(slug: string): NoSlashString {
  const segments = slug.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`CircleCI plugin: "${slug}" is not a CircleCI slug`);
  }
  return unencodedSegment(segments.map(encodeURIComponent).join("/"));
}

/** The runner host's calls, by hand: it publishes no document. */
export interface RunnerPaths {
  "/runner/tasks": { get: RunnerTasksGet<{ unclaimed_task_count?: number }> };
  "/runner/tasks/running": { get: RunnerTasksGet<{ running_runner_tasks?: number }> };
}

interface RunnerTasksGet<Body> {
  parameters: { query: { "resource-class": string } };
  responses: { 200: { content: { "application/json": Body } } };
}

/** Every client a call may need. Building them only allocates closures. */
export function circleApi(ctx: CircleContext) {
  const shared = {
    vendor: "CircleCI",
    http: ctx.http,
    contentType: "with-body",
    httpError: ({ status, path, body }) =>
      new CircleApiError(status, `CircleCI API error ${status} for ${path}: ${errorDetail(body)}`),
  } satisfies Partial<ApiClientOptions>;
  const accept = { Accept: "application/json" };
  const circleToken = { ...accept, "Circle-Token": ctx.token };

  const v2 = createApiClient<V2Paths>({ ...shared, baseUrl: API_BASE, headers: circleToken });
  const v3 = createApiClient<V3Paths>({
    ...shared,
    baseUrl: API_V3_BASE,
    headers: { ...accept, Authorization: `Bearer ${ctx.token}` },
  });
  const runner = createApiClient<RunnerPaths>({
    ...shared,
    baseUrl: RUNNER_API_BASE,
    headers: circleToken,
  });

  // Both walks carry on past an empty page while a cursor is on offer, and read a
  // 2xx with no body as the end of the list: that is what the plugin has always
  // done. `maxPages` is each list's cap unless the call names its own.
  const v2Paged = withCursorPagination(v2, {
    cursorParam: "page-token",
    next: "next_page_token",
    maxPages: 10,
    continueOnEmptyPage: true,
    emptyBodyEndsList: true,
  });
  const v3Paged = withCursorPagination(v3, {
    cursorParam: "page[cursor]",
    next: "page.next",
    maxPages: 20,
    continueOnEmptyPage: true,
    emptyBodyEndsList: true,
  });
  return { v2, v3, runner, v2Paged, v3Paged };
}

export type CircleApi = ReturnType<typeof circleApi>;

/**
 * Download a usage export file (a presigned object-store URL, no token). The
 * files are gzip-compressed CSV; decompress when the bytes say so, since a
 * transparent `Content-Encoding` may already have done it.
 */
export async function downloadExport(ctx: CircleContext, url: string): Promise<string> {
  let bytes: Uint8Array;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method: "GET",
      headers: {},
      responseEncoding: "binary",
    });
    if (res.status < 200 || res.status >= 300) {
      throw new CircleApiError(res.status, `CircleCI usage export download failed (${res.status})`);
    }
    bytes = res.rawBody ?? new TextEncoder().encode(res.body);
  } else {
    const res = await fetch(url);
    if (!res.ok) {
      throw new CircleApiError(res.status, `CircleCI usage export download failed (${res.status})`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  return gunzipIfNeeded(bytes);
}

/** Decode bytes as UTF-8, gunzipping first when they carry the gzip magic number. */
export async function gunzipIfNeeded(bytes: Uint8Array): Promise<string> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}
