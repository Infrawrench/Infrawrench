import type { HttpHostServices, NextPage } from "@infrawrench/plugin-base";
import {
  createApiClient,
  findNextLink,
  linkHostsUnder,
  withLinkPagination,
} from "@infrawrench/plugin-base";
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
  return findNextLink(link, { when: (params) => params["results"] === "true" });
}

const nextPage: NextPage = ({ headers }) => nextPageUrl(headers["link"]);

/**
 * The API, with `getAll` for cursor-paginated lists: 100 rows a page, the most the
 * document allows, up to `maxPages` (50,000 rows unless a call says otherwise), past
 * which a list throws rather than come back short. Sentry pages with a `Link` header and
 * reports totals in `X-Hits`; `getResponse` is what reads the second.
 *
 * Next links are written on `system.url-prefix` rather than the host asked. For
 * sentry.io that is another host under sentry.io. For a self-hosted install it is
 * whatever the install was told, which need not be the address this connection
 * uses, so only the link's path and cursor are read and the token stays where the
 * account points it.
 */
export function sentryApi(ctx: SentryContext) {
  const root = apiRoot(ctx);
  return withLinkPagination(client(ctx), {
    next: nextPage,
    sizeParam: "per_page",
    pageSize: 100,
    maxPages: 500,
    // The pagination guide ends a list at `results=false`, so an empty page does not.
    continueOnEmptyPage: true,
    foreignLinks: ctx.instance.selfHosted ? "refuse" : linkHostsUnder("sentry.io"),
    resolveLink: (link) => {
      const url = new URL(link, `${root}/`);
      const at = url.pathname.indexOf("/api/0/");
      return ctx.instance.selfHosted && at >= 0
        ? `${root}${url.pathname.slice(at + "/api/0".length)}${url.search}`
        : url.href;
    },
  });
}

export type SentryApi = ReturnType<typeof sentryApi>;
