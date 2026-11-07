import type { ApiFailure, HttpHostServices, NoSlashString } from "@infrawrench/plugin-base";
import {
  createApiClient,
  pathEncode,
  restRequest,
  utf8ToBase64,
  withLinkPagination,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * Bitbucket Cloud REST API 2.0 (https://api.bitbucket.org/2.0, OpenAPI at
 * https://api.bitbucket.org/swagger.json, verified 2026-10).
 *
 * - Typed from that document by plugingen; `plugingen.json` lists the operations
 *   and says why each patch is there.
 * - Auth: an Atlassian API token with scopes is sent as HTTP Basic with the
 *   Atlassian account **email** (not the Bitbucket username) as the user.
 *   Workspace, project and repository access tokens are sent as Bearer.
 *   App passwords were switched off on 2026-06-09 and are not supported.
 * - Lists are `{ values, next, page, pagelen, size }`; `next` is an absolute
 *   URL to follow verbatim. `pagelen` tops out at 100 on most lists.
 * - UUIDs are written with braces (`{1234-...}`) and must be URL-encoded in
 *   paths.
 */

export const API_BASE = "https://api.bitbucket.org/2.0";
export const WEB_BASE = "https://bitbucket.org";

/** A whole list is read up to 10,000 rows, at the documented maximum of 100 a page. */
const LIST_PAGES = 100;
/** Pages read for a picker, most useful first. Part of a list is fine there. */
export const PICKER_PAGES = 10;

export interface BitbucketContext {
  /** Atlassian account email for API tokens; empty for access tokens (Bearer). */
  email?: string;
  token: string;
  workspace: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers (and the poller) branch on. */
export class BitbucketApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BitbucketApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof BitbucketApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

export function isAbsent(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404;
}

export function authHeader(ctx: Pick<BitbucketContext, "email" | "token">): string {
  return ctx.email ? `Basic ${utf8ToBase64(`${ctx.email}:${ctx.token}`)}` : `Bearer ${ctx.token}`;
}

/** Unvalidated: every field is checked below before it is shown. */
interface BitbucketErrorBody {
  error?: { message?: unknown; detail?: unknown; fields?: Record<string, unknown> };
  message?: unknown;
}

/** Bitbucket errors are `{"type": "error", "error": {"message": "...", "detail": ...}}`. */
export function errorDetail(body: string): string {
  try {
    const parsed: BitbucketErrorBody = JSON.parse(body);
    const e = parsed.error;
    if (e) {
      const parts = [typeof e.message === "string" ? e.message : ""];
      if (typeof e.detail === "string") parts.push(e.detail);
      else if (e.detail && typeof e.detail === "object") parts.push(JSON.stringify(e.detail));
      if (e.fields) {
        parts.push(
          Object.entries(e.fields)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
            .join("; "),
        );
      }
      const joined = parts.filter(Boolean).join(": ");
      if (joined) return joined;
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 500);
}

function apiError(status: number, method: string, shown: string, body: string): BitbucketApiError {
  return new BitbucketApiError(
    status,
    `Bitbucket API error ${status} for ${method} ${shown}: ${errorDetail(body)}`,
  );
}

/** A failed request names the path as called, and a followed link by its path or as written. */
function httpError({ status, method, path, body, link }: ApiFailure): BitbucketApiError {
  const shown = link === undefined ? path : link.startsWith("http") ? new URL(link).pathname : link;
  return apiError(status, method, shown, body);
}

/**
 * The typed clients for one set of credentials. Routed through the host HTTP
 * service whenever there is one: that is the only path that honours bastion
 * egress.
 *
 * The document says of `next` that "the last page of a collection does not have
 * this value", so an empty page naming one is not the end of the list. It documents
 * `values` with `minItems: 0` and no empty answer, so a page without one throws.
 */
export function bitbucketClients(ctx: Pick<BitbucketContext, "email" | "token" | "http">) {
  const api = createApiClient<paths>({
    vendor: "Bitbucket",
    baseUrl: API_BASE,
    headers: { Authorization: authHeader(ctx), Accept: "application/json" },
    http: ctx.http,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    httpError,
  });
  const lists = withLinkPagination(api, {
    next: "next",
    sizeParam: "pagelen",
    pageSize: 100,
    maxPages: LIST_PAGES,
    continueOnEmptyPage: true,
  });
  return { api, lists };
}

/**
 * A POST whose answer is not read, and need not be JSON: `api.post` would parse
 * it, and `getText` is GET only.
 */
export async function bbPostUnread(
  ctx: Pick<BitbucketContext, "email" | "token" | "http">,
  path: string,
  body?: object,
): Promise<void> {
  await restRequest<string>({
    vendor: "Bitbucket",
    url: `${API_BASE}${path}`,
    headers: { Authorization: authHeader(ctx), Accept: "application/json" },
    init: { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    ...(ctx.http ? { http: ctx.http } : {}),
    contentType: "with-body",
    responseAs: "text",
    httpError: ({ status, body: text }) => apiError(status, "POST", path, text),
  });
}

/** `{uuid}` in a path. Accepts the UUID with or without braces. */
export function encUuid(uuid: string): NoSlashString {
  const v = uuid.trim();
  return pathEncode(v.startsWith("{") ? v : `{${v}}`);
}

/** Split `head/rest` at the first slash: composite external ids. */
export function splitScoped(id: string): { scope: string; rest: string } {
  const i = id.indexOf("/");
  if (i < 0) return { scope: id, rest: "" };
  return { scope: id.slice(0, i), rest: id.slice(i + 1) };
}
