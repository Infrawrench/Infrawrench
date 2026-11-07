import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  type ApiClient,
  type HostServices,
  type HttpHostServices,
  type NoSlashString,
  pathEncode,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";
import { canonicalQuery, signRequest } from "./signing.js";

/**
 * Transport for the Crusoe Cloud API (`https://api.cloud.crusoe.ai/v1`, the
 * host Crusoe's own Terraform provider migrated to from
 * `api.crusoecloud.com/v1alpha5`). Every request is HMAC-signed; see
 * `signing.ts`. Goes through `services.http` when the host provides it, which
 * is what keeps bastion routing and custom CAs working.
 *
 * Requests are typed from Crusoe's OpenAPI document (`plugingen.json`). The
 * signature covers the exact path and query, so it is added in `crusoeTransport`,
 * which is what the typed client gets as its `http`.
 */

export const API_HOST = "https://api.cloud.crusoe.ai";
export const API_PREFIX = "/v1";

const ACCEPT = "application/json, text/csv";

export class CrusoeApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Crusoe API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "CrusoeApiError";
    this.status = status;
    this.body = body;
  }
}

/** Crusoe errors are `{code, message}`; show the message, not the JSON. */
function summarizeBody(body: string): string {
  try {
    const parsed: { message?: string } = JSON.parse(body);
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

export interface CrusoeCredentials {
  accessKeyId: string;
  secretKey: string;
  monitoringToken: string;
  caCert: string;
}

/**
 * An id fit to name one object. A URL parser walks up `.` and `..` even when written
 * as `%2E`, so no encoding keeps those from changing which route gets called.
 */
export function requireId(id: string): string {
  if (!id.trim() || id === "." || id === "..") {
    throw new Error(`Crusoe plugin: "${id}" is not a usable id`);
  }
  return id;
}

export const seg = (id: string): NoSlashString => pathEncode(requireId(id));

type Authenticate = (
  method: string,
  path: string,
  query: string,
) => Promise<Record<string, string>>;

/** The whole of a request but its typed shape: the URL, auth, and which way it goes out. */
function crusoeTransport(auth: Authenticate, services: HostServices | undefined): HttpHostServices {
  const http = services?.http;
  return {
    request: async ({ url, method, headers: extra, body, caCert }) => {
      const start = url.indexOf("?");
      const path = url.slice(API_HOST.length, start < 0 ? undefined : start);
      const query = start < 0 ? "" : url.slice(start + 1);
      const headers = {
        Accept: ACCEPT,
        ...(await auth(method, decodeURIComponent(path), query)),
        ...extra,
      };
      if (http) {
        return http.request({
          url,
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(caCert ? { caCert } : {}),
        });
      }
      // The typed client only ever writes text.
      const res = await fetch(url, {
        method,
        headers,
        ...(typeof body === "string" ? { body } : {}),
      });
      return { status: res.status, headers: {}, body: await res.text() };
    },
  };
}

export type CrusoeApi = ApiClient<paths> & {
  /**
   * For the metrics endpoints: `Authorization: Bearer <token>` when the account
   * has a monitoring token, and an HMAC signature like everything else when not.
   */
  metrics: ApiClient<paths>;
};

export function createCrusoeApi(
  creds: CrusoeCredentials,
  services: HostServices | undefined,
): CrusoeApi {
  const client = (auth: Authenticate) =>
    createApiClient<paths>({
      vendor: "Crusoe",
      baseUrl: `${API_HOST}${API_PREFIX}`,
      headers: {},
      http: crusoeTransport(auth, services),
      caCert: creds.caCert,
      contentType: "with-body",
      emptyBodyIsUndefined: true,
      serializeQuery: canonicalQuery,
      httpError: ({ status, path, body }) => new CrusoeApiError(status, path, body),
    });
  const signed = client((method, path, query) =>
    signRequest({
      accessKeyId: creds.accessKeyId,
      secretKey: creds.secretKey,
      method,
      path,
      query,
    }),
  );
  const token = creds.monitoringToken;
  return {
    ...signed,
    metrics: token ? client(async () => ({ Authorization: `Bearer ${token}` })) : signed,
  };
}

const VENDOR = "Crusoe";

/**
 * The document gives no page size or maximum for any list, so none is sent and a page
 * can hold any number of rows: the page cap stops a repeating token, the row cap
 * stops a list longer than the host can prune.
 */
const MAX_PAGES = 1_000;
const MAX_ROWS = 50_000;

/** A list answer's rows. The document requires `items`, so an answer without it is no answer. */
export function pageItems<Item>(
  res: { items?: readonly Item[] | null } | undefined,
  path: string,
): Item[] {
  return requireListPage(res?.items, { vendor: VENDOR, path, key: "items", page: res });
}

/**
 * Every page of a list endpoint. Crusoe paginates with `next_token` in the
 * request and `next_page_token` in the response, and only some lists
 * paginate at all; one that returns no token is simply a single page.
 *
 * `path` names the route in errors. A loop rather than `withCursorPagination`, which
 * only takes the routes the document says have a cursor: most of these do not.
 */
export async function listAll<Item>(
  path: string,
  fetchPage: (query: {
    next_token?: string;
  }) => Promise<{ items?: readonly Item[]; next_page_token?: string } | undefined>,
): Promise<Item[]> {
  const items: Item[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchPage(token ? { next_token: token } : {});
    items.push(...pageItems(res, path));
    token = res?.next_page_token || undefined;
    if (!token) return items;
    if (items.length >= MAX_ROWS) {
      throw new ListTruncatedError({
        vendor: VENDOR,
        path,
        items: items.length,
        maxItems: MAX_ROWS,
      });
    }
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: items.length, maxPages: MAX_PAGES });
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof CrusoeApiError && statuses.includes(err.status);
}
