import type { HttpHostServices, NextPage } from "@infrawrench/plugin-base";
import { createApiClient, withLinkPagination } from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";
import type { SentryInstance } from "./regions.js";

/**
 * Everything a Sentry API request needs. Split out of the client so the cost
 * collector, the credential-option loader, preflight and the tests can run
 * without one.
 */
export interface SentryContext {
  token: string;
  instance: SentryInstance;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class SentryApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SentryApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof SentryApiError ? err.status : 0;
}

/** True for the answers that mean "this token may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/** Unvalidated: the field is checked below before it is shown. */
interface ErrorBody {
  detail?: string | null;
}

function errorDetail(body: string): string {
  try {
    const parsed: ErrorBody = JSON.parse(body);
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return body.slice(0, 500);
}

const apiRoot = (ctx: SentryContext) => `${ctx.instance.apiUrl.replace(/\/+$/, "")}/api/0`;

/**
 * What an error names: the path as the call wrote it, or for a followed link
 * the link's pathname, or the link itself where it was not absolute. Always
 * without the query.
 */
function failedPath(path: string, link: string | undefined): string {
  if (link === undefined) return path;
  return link.startsWith("http") ? new URL(link).pathname : link;
}

/**
 * The instance's API (`<apiBase>/api/0<path>`), with the token as a Bearer
 * header, typed from Sentry's OpenAPI document by plugingen (`plugingen.json`
 * lists the operations and says why each patch is there).
 *
 * Routed through the host HTTP service whenever there is one: that is the
 * only path that honours bastion egress and a custom CA.
 */
function client(ctx: SentryContext) {
  return createApiClient<paths>({
    vendor: "Sentry",
    baseUrl: apiRoot(ctx),
    headers: { Accept: "application/json", Authorization: `Bearer ${ctx.token}` },
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    httpError: ({ status, path, link, body }) =>
      new SentryApiError(
        status,
        `Sentry API error ${status} for ${failedPath(path, link)}: ${errorDetail(body)}`,
      ),
    ...(ctx.http ? { http: ctx.http } : {}),
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
  });
}

/**
 * The next page's URL from a Sentry `Link` header, or undefined when there is
 * none. Sentry always sends a `rel="next"` link and says whether it has
 * anything behind it with `results="true"|"false"`, so the flag (not the
 * link's presence) is what ends the loop.
 */
export function nextPageUrl(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const url = /<([^>]+)>/.exec(part)?.[1];
    if (!url) continue;
    if (!/rel="next"/.test(part)) continue;
    if (!/results="true"/.test(part)) return undefined;
    return url;
  }
  return undefined;
}

const nextPage: NextPage = ({ headers }) => nextPageUrl(headers["link"]);

/**
 * The API, with `getAll` for cursor-paginated lists: 100 rows a page, up to
 * `maxPages` (20 unless a call says otherwise), so a misbehaving cursor cannot
 * spin forever. Sentry pages with a `Link` header and reports totals in
 * `X-Hits`; `getResponse` is what reads the second.
 *
 * An empty page does not end a list, only the link does. A link not starting
 * `http` is read as a path under the API root, as this plugin always has.
 */
export function sentryApi(ctx: SentryContext) {
  const root = apiRoot(ctx);
  return withLinkPagination(client(ctx), {
    next: nextPage,
    sizeParam: "per_page",
    pageSize: 100,
    maxPages: 20,
    continueOnEmptyPage: true,
    foreignLinks: "follow",
    resolveLink: (link) => (link.startsWith("http") ? link : `${root}${link}`),
  });
}

export type SentryApi = ReturnType<typeof sentryApi>;
