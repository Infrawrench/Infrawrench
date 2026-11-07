import {
  createApiClient,
  withCursorPagination,
  type CursorApiClient,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { components, paths } from "./api-types.gen.js";

/**
 * CockroachDB Cloud API (`https://cockroachlabs.cloud/api/v1`). Typed from the
 * OpenAPI document named in `plugingen.json`, and see
 * docs.cockroachlabs.com/docs/cockroachcloud/cloud-api.
 *
 * - Auth: `Authorization: Bearer <secret>` where the secret is an API key of a
 *   service account (`CCDB1_…`), which carries that account's roles.
 * - `Cc-Version` pins the API version; omitting it means "latest".
 * - 10 requests a second per user, answered with 429 + `Retry-After`.
 * - Lists page with `pagination.page` / `pagination.limit` and answer
 *   `pagination.next_page`.
 * - Errors are `{code, message, details}` (gRPC status shape).
 */
export const CRDB_API = "https://cockroachlabs.cloud";
export const CC_VERSION = "2026-09-15";

export interface CrdbContext {
  token: string;
  http?: HttpHostServices;
  caCert?: string;
}

export class CrdbApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CrdbApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof CrdbApiError ? err.status : 0;
}

export function toError(status: number, path: string, raw: string): CrdbApiError {
  let message = "";
  try {
    const parsed: { message?: string } = JSON.parse(raw);
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    message = raw.slice(0, 300);
  }
  if (status === 401) {
    return new CrdbApiError(
      401,
      "CockroachDB Cloud API error 401: the API key was rejected. Create a new key for a service account under Organization > Access Management > Service Accounts.",
    );
  }
  if (status === 429) {
    return new CrdbApiError(
      429,
      `CockroachDB Cloud API error 429 for ${path}: rate limited (10 requests a second). Try again shortly.`,
    );
  }
  return new CrdbApiError(
    status,
    `CockroachDB Cloud API error ${status} for ${path}${message ? `: ${message}` : ""}`,
  );
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The host's HTTP service where there is one and `fetch` where there is not. A write
 * answered with a 2xx that is not JSON has always been read as its text and a body on
 * a 204 kept, where `restRequest` would throw and report a change that happened as a
 * failure, so such a body reaches it as JSON and as a 200. A read gets no such help: a
 * list that cannot say what it holds must fail, or a sync prunes on it.
 */
function crdbTransport(http: HttpHostServices | undefined): HttpHostServices {
  const send: HttpHostServices["request"] = async (req) => {
    if (http) return http.request(req);
    const { url, method, headers, body } = req;
    // The client only ever sends JSON text.
    const res = await fetch(url, {
      method,
      headers,
      ...(typeof body === "string" ? { body } : {}),
    });
    return { status: res.status, headers: {}, body: await res.text() };
  };
  return {
    request: async (req) => {
      const res = await send(req);
      if (res.status < 200 || res.status >= 300 || !res.body) return res;
      if (req.method === "GET") {
        if (isJson(res.body)) return res;
        throw new CrdbApiError(
          res.status,
          `CockroachDB Cloud answered ${new URL(req.url).pathname} with a body that is not JSON.`,
        );
      }
      return { ...res, status: 200, body: isJson(res.body) ? res.body : JSON.stringify(res.body) };
    },
  };
}

type Paged = CursorApiClient<
  paths,
  {
    cursorParam: "pagination.page";
    sizeParam: "pagination.limit";
    next: "pagination.next_page";
    hasMore: never;
  }
>;

export type CrdbApi = Paged & { getAllOptionalKey: Paged["getAll"] };

export function createCrdbApi(ctx: CrdbContext): CrdbApi {
  const client = createApiClient<paths>({
    vendor: "CockroachDB Cloud",
    baseUrl: CRDB_API,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/json",
      "Cc-Version": CC_VERSION,
    },
    http: crdbTransport(ctx.http),
    caCert: ctx.caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    httpError: ({ status, path, body }) => toError(status, path, body),
  });
  const paging = {
    cursorParam: "pagination.page",
    sizeParam: "pagination.limit",
    pageSize: 200,
    maxPages: 100,
    next: "pagination.next_page",
    // The document's only end to a list is `next_page` going away. Walking on past an
    // empty page can only fail closed, at `maxPages`; stopping there could read short.
    continueOnEmptyPage: true,
  } as const;
  const api = withCursorPagination(client, paging);
  // The document requires the list key on every list response but blackout windows
  // and egress rules, where proto3 JSON may leave out an empty one.
  const optionalKey = withCursorPagination(client, { ...paging, missingListIsEmpty: true });
  return { ...api, getAllOptionalKey: optionalKey.getAll };
}

export type CCluster = components["schemas"]["Cluster"];
export type CBackupConfig = components["schemas"]["BackupConfiguration"];
export type CAllowlistEntry = components["schemas"]["AllowlistEntry"];
export type CFolder = components["schemas"]["FolderResource"];
export type CServiceAccount = components["schemas"]["ServiceAccount"];
export type CApiKey = components["schemas"]["ApiKey"];
export type CInvoice = components["schemas"]["Invoice"];
export type CRestore = components["schemas"]["Restore"];
