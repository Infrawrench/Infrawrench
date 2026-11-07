import {
  createApiClient,
  restRequest,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.management.gen.js";
import type { paths as storagePaths } from "./api-types.storage.gen.js";

/**
 * Supabase Management API (`https://api.supabase.com/v1`, OpenAPI document at
 * `https://api.supabase.com/api/v1-json`; verified 2026-10).
 *
 * Auth is a personal access token (`sbp_…`, classic or scoped) sent as a
 * Bearer token. The documented limit is 120 requests a minute per user and
 * per project/organization scope, with the analytics endpoints (logs, usage
 * counts) capped far lower (10-30 a minute), which is why logs and metrics
 * are only fetched on demand.
 *
 * The Storage API (bucket create/update/delete, object browser) is not part
 * of the Management API: it lives on the project's own gateway at
 * `https://{ref}.supabase.co/storage/v1`, with its own document at
 * `https://supabase.github.io/storage/api.json`, and authenticates with one of
 * the project's secret API keys, which this layer reads through the Management
 * API so the user never has to paste one.
 */
export const SUPABASE_API = "https://api.supabase.com";

export interface SupabaseContext {
  token: string;
  http?: HttpHostServices;
  /** Overridable for tests; production always uses {@link SUPABASE_API}. */
  baseUrl?: string;
  caCert?: string;
}

/** A Management API operation's response, by its `operationId`. */
export type SupabaseResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

/** Thrown for any non-2xx answer, carrying the status the poller classifies on. */
export class SupabaseApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SupabaseApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  if (err instanceof SupabaseApiError) return err.status;
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = err.status;
    return typeof status === "number" ? status : 0;
  }
  return 0;
}

/** One HTTP round trip, through the host's HTTP service whenever there is one. */
function plainTransport(ctx: SupabaseContext): HttpHostServices {
  return {
    async request(req) {
      if (ctx.http) {
        return ctx.http.request({
          url: req.url,
          method: req.method,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
          ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
        });
      }
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined
          ? { body: typeof req.body === "string" ? req.body : new Uint8Array(req.body) }
          : {}),
      });
      // Nothing in this plugin reads a response header.
      return { status: res.status, headers: {}, body: await res.text() };
    },
  };
}

/**
 * Several of these endpoints answer a 2xx with a plain word, or a 204 with a body,
 * and what they said has always come back as it stands rather than failing the
 * call. The client parses every 2xx and drops a 204's body, so hand it that text
 * as JSON and the body under a status it reads.
 */
function lenientTransport(ctx: SupabaseContext): HttpHostServices {
  const plain = plainTransport(ctx);
  return {
    async request(req) {
      const res = await plain.request(req);
      if (res.status < 200 || res.status >= 300 || !res.body) return res;
      const status = res.status === 204 ? 200 : res.status;
      try {
        JSON.parse(res.body);
        return { ...res, status };
      } catch {
        return { ...res, status, body: JSON.stringify(res.body) };
      }
    },
  };
}

function managementClient(ctx: SupabaseContext, http: HttpHostServices) {
  return createApiClient<paths>({
    vendor: "Supabase",
    baseUrl: ctx.baseUrl ?? SUPABASE_API,
    headers: { Authorization: `Bearer ${ctx.token}`, Accept: "application/json" },
    http,
    contentType: "with-body",
    httpError: ({ status, path, body }) =>
      new SupabaseApiError(status, friendlyError(status, path, body)),
  });
}

/** JSON requests against the Management API. An empty body reads as `undefined`. */
export function supabaseApi(ctx: SupabaseContext) {
  return managementClient(ctx, lenientTransport(ctx));
}

export type SupabaseApi = ReturnType<typeof supabaseApi>;

/** For `getText`: the Prometheus scrape endpoint answers text/plain. */
export function supabaseTextApi(ctx: SupabaseContext) {
  return managementClient(ctx, plainTransport(ctx));
}

/**
 * New `sb_secret_…` keys go in the `apikey` header only (the gateway mints the
 * service-role JWT itself; they are not JWTs and must not be sent as a Bearer
 * token). A legacy `service_role` key is a JWT and is sent in both headers.
 */
function storageHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key, Accept: "application/json" };
  if (key.startsWith("eyJ")) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

/** A project's Storage API, signed with one of its secret API keys. */
export function supabaseStorageApi(ctx: SupabaseContext, ref: string, key: string) {
  return createApiClient<storagePaths>({
    vendor: "Supabase",
    baseUrl: `${projectUrl(ref)}/storage/v1`,
    headers: storageHeaders(key),
    http: lenientTransport(ctx),
    contentType: "with-body",
    httpError: ({ status, path, body }) =>
      new SupabaseApiError(status, friendlyError(status, `storage${path}`, body)),
  });
}

/** A POST whose body is not JSON, which the typed clients cannot send. */
async function postBytes<T>(
  ctx: SupabaseContext,
  request: {
    url: string;
    errorPath: string;
    headers: Record<string, string>;
    body: Uint8Array;
  },
): Promise<T> {
  const { url, errorPath, headers, body } = request;
  const { body: answer } = await restRequest<T>({
    vendor: "Supabase",
    url,
    headers,
    init: { method: "POST", body: new Uint8Array(body) },
    http: lenientTransport(ctx),
    contentType: "with-body",
    httpError: ({ status, body: text }) =>
      new SupabaseApiError(status, friendlyError(status, errorPath, text)),
  });
  return answer;
}

/** Deploy an Edge Function: multipart, so outside what the Management client can send. */
export function deployFunctionBundle(
  ctx: SupabaseContext,
  path: `/v1/projects/${string}/functions/deploy`,
  slug: string,
  contentType: string,
  body: Uint8Array,
): Promise<SupabaseResponse<"v1-deploy-a-function">> {
  const query = new URLSearchParams({ slug }).toString();
  return postBytes(ctx, {
    url: `${ctx.baseUrl ?? SUPABASE_API}${path}?${query}`,
    errorPath: path,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/json",
      "Content-Type": contentType,
    },
    body,
  });
}

/** Upload an object: raw bytes, so outside what the Storage client can send. */
export async function uploadStorageBytes(
  ctx: SupabaseContext,
  request: {
    ref: string;
    key: string;
    path: string;
    errorPath: string;
    contentType: string;
    body: Uint8Array;
  },
): Promise<void> {
  const { ref, key, path, errorPath, contentType, body } = request;
  await postBytes<object>(ctx, {
    url: `${projectUrl(ref)}/storage/v1${path}`,
    errorPath,
    headers: { ...storageHeaders(key), "Content-Type": contentType, "x-upsert": "true" },
    body,
  });
}

/** Turn an error body into a sentence, keeping Supabase's own `message`. */
export function friendlyError(status: number, path: string, raw: string): string {
  let detail = "";
  try {
    const parsed: { message?: unknown; error?: unknown; msg?: unknown } = JSON.parse(raw);
    const candidate = parsed.message ?? parsed.msg ?? parsed.error;
    if (typeof candidate === "string") detail = candidate;
    else if (candidate && typeof candidate === "object" && "message" in candidate) {
      detail = String(candidate.message);
    }
  } catch {
    detail = raw.slice(0, 300);
  }
  if (status === 401) {
    return "Supabase API error 401: the access token was rejected. Create a new token at supabase.com/dashboard/account/tokens and update the account.";
  }
  if (status === 403 && !detail) {
    return `Supabase API error 403 for ${path}: the access token's scopes do not allow this call.`;
  }
  if (status === 429) {
    return `Supabase API error 429 for ${path}: rate limited (120 requests a minute per project, far fewer for logs and analytics). Try again shortly.`;
  }
  return `Supabase API error ${status} for ${path}${detail ? `: ${detail}` : ""}`;
}

/** URL of a project's own API gateway. */
export function projectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}
