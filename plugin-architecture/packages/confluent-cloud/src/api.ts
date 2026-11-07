import {
  createApiClient,
  restRequest,
  utf8ToBase64,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths as ManagementPaths } from "./api-types.management.gen.js";
import type { paths as TelemetryPaths } from "./api-types.telemetry.gen.js";

/**
 * Confluent Cloud has two HTTP surfaces this plugin talks to, both of which
 * authenticate with the same organization-level **Cloud API key** sent as
 * HTTP Basic (`key:secret`), and each typed from its own document
 * (`plugingen.json`):
 *
 * - `https://api.confluent.cloud`: every management API (org, IAM, cmk,
 *   connect, fcpm, ksqldbcm, srcm, networking, byok) and the Billing Costs
 *   API, from https://docs.confluent.io/cloud/current/openapi.yaml.
 * - `https://api.telemetry.confluent.cloud`: the Metrics API
 *   (`POST /v2/metrics/cloud/query`), from
 *   https://api.telemetry.confluent.cloud/docs/api.yaml. A Cloud API key is
 *   required there too; cluster-scoped keys are rejected.
 */
export const MANAGEMENT_API = "https://api.confluent.cloud";
export const TELEMETRY_API = "https://api.telemetry.confluent.cloud";
export const CONSOLE_URL = "https://confluent.cloud";

/** What every list asks for, unless it says otherwise. */
export const PAGE_SIZE = 100;
const VENDOR = "Confluent Cloud";

export interface ConfluentCredentials {
  apiKey: string;
  apiSecret: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class ConfluentApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ConfluentApiError";
    this.status = status;
  }
}

function apiError(status: number, path: string, body: string): ConfluentApiError {
  return new ConfluentApiError(status, `${VENDOR} API error ${status} for ${path}: ${body}`);
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
 * The host's HTTP service whenever there is one, that being the only path that
 * honours bastion egress and a custom CA, and otherwise the global fetch. Either
 * way a 2xx whose body is not JSON reads as no body: action endpoints (connector
 * pause/resume, 202 Accepted) can answer with nothing at all.
 */
function lenientTransport(http: HttpHostServices | undefined): HttpHostServices {
  const send: HttpHostServices["request"] = async (req) => {
    if (http) return http.request(req);
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined
        ? { body: typeof req.body === "string" ? req.body : req.body.slice() }
        : {}),
    });
    // Nothing here reads a response header.
    return { status: res.status, headers: {}, body: await res.text() };
  };
  return {
    async request(req) {
      const res = await send(req);
      const ok = res.status >= 200 && res.status < 300;
      return ok && res.body && !isJson(res.body) ? { ...res, body: "" } : res;
    },
  };
}

/** Build everything a request needs. Split out of the client so tests can build one. */
export function createConfluentContext({ apiKey, apiSecret, caCert, http }: ConfluentCredentials) {
  const shared = {
    vendor: VENDOR,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${utf8ToBase64(`${apiKey}:${apiSecret}`)}`,
    },
    http: lenientTransport(http),
    ...(caCert ? { caCert } : {}),
  };
  const clients = {
    ...shared,
    httpError: ({ status, path, body }: { status: number; path: string; body: string }) =>
      apiError(status, path, body),
    // An empty value means "no filter", so an environment id that came back empty
    // sends no parameter at all rather than `environment=`.
    serializeQuery: (query: Record<string, ParamValue>) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") params.set(key, String(value));
      }
      return params.toString();
    },
  };
  return {
    apiKey,
    /** What following a next link needs: no operation in the document has that shape. */
    transport: shared,
    api: createApiClient<ManagementPaths>({ ...clients, baseUrl: MANAGEMENT_API }),
    telemetry: createApiClient<TelemetryPaths>({ ...clients, baseUrl: TELEMETRY_API }),
  };
}

export type ConfluentContext = ReturnType<typeof createConfluentContext>;

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof ConfluentApiError ? err.status : 0;
}

/** True for the answers that mean "this key's owner may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/** What {@link ccList} reads from a page. Every management list fits it. */
interface ListPage<Item> {
  data?: readonly Item[] | null;
  metadata?: { next?: string | null } | null;
}

/** A next link as Confluent wrote it: absolute, as far as anyone has seen. */
async function followLink<Page>(ctx: ConfluentContext, link: string): Promise<Page> {
  const absolute = /^https?:\/\//.test(link);
  const errorPath = absolute ? new URL(link).pathname : link;
  const { body } = await restRequest<Page>({
    ...ctx.transport,
    url: absolute ? link : `${MANAGEMENT_API}${link}`,
    errorPath,
    httpError: ({ status, body: text }) => apiError(status, errorPath, text),
  });
  return body;
}

/**
 * Walk a Confluent list endpoint from its first page, which is what types the
 * rest. Every list in the management API shares one shape: `{ data: [...],
 * metadata: { next } }`, where `next` is an absolute URL carrying an opaque
 * `page_token`. Hard-stops at `maxPages` so a misbehaving cursor cannot spin
 * forever.
 *
 * This is a hand loop rather than `withLinkPagination` because that reads a `data`
 * that is not an array as an empty page, and the host prunes what a sync stops
 * seeing. Here spreading it throws, so the sync fails, as it always has.
 */
export async function ccList<Item>(
  ctx: ConfluentContext,
  first: () => Promise<ListPage<Item>>,
  maxPages = 100,
): Promise<Item[]> {
  const out: Item[] = [];
  let next: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res: ListPage<Item> = next ? await followLink<ListPage<Item>>(ctx, next) : await first();
    out.push(...(res.data ?? []));
    const link = res.metadata?.next;
    if (!link || (res.data ?? []).length === 0) break;
    next = link;
  }
  return out;
}
