/**
 * The request surface every Linode module uses.
 *
 * Linode API v4 (https://techdocs.akamai.com/linode-api/reference/api) is a
 * plain JSON REST API at `https://api.linode.com/v4`, authenticated with a
 * personal access token as `Authorization: Bearer <token>`. Collections are
 * paginated with `page` / `page_size` (25 to 500) and return
 * `{ data, page, pages, results }`; filtering rides in an `X-Filter` header
 * carrying a JSON object.
 *
 * Errors keep the HTTP status on the thrown object (`LinodeApiError.status`).
 * Hosts classify failures for backoff from that number, and reading a status
 * back out of prose is unreliable (see KNOWLEDGE.md, GCP section).
 */

import {
  createApiClient,
  unencodedSegment,
  type ApiClient,
  type ApiClientOptions,
  type ApiResponse,
  type HostServices,
  type HttpHostServices,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

export const LINODE_API_BASE = "https://api.linode.com/v4";
/** Akamai Cloud Pulse metrics live on their own host and version. */
export const LINODE_MONITOR_BASE = "https://monitor-api.linode.com/v2beta";

export class LinodeApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string, body: string) {
    super(`Linode API error ${status} for ${path}: ${summariseErrorBody(body)}`);
    this.name = "LinodeApiError";
    this.status = status;
  }
}

interface ErrorBody {
  errors?: Array<{ field?: string; reason?: string }>;
}

/** Linode errors are `{ errors: [{ field?, reason }] }`; flatten them for a message. */
function summariseErrorBody(body: string): string {
  try {
    const parsed: ErrorBody = JSON.parse(body);
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return parsed.errors
        .map((e) => (e.field ? `${e.field}: ${e.reason ?? ""}` : (e.reason ?? "")))
        .join("; ");
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.slice(0, 500);
}

export function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
    return err.status;
  }
  return undefined;
}

/** An operation's response, by its `operationId`. */
export type LinodeResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

export type LinodeApi = ApiClient<paths> & {
  /** The Cloud Pulse metrics host, with a service-scoped token rather than the account's. */
  monitor(token: string): ApiClient<paths>;
};

export interface LinodeApiConfig {
  token: string;
  services?: HostServices | undefined;
  caCert?: string;
  baseUrl?: string;
  monitorBaseUrl?: string;
}

const PAGE_SIZE = 500;

/**
 * Every page of a collection. `fetchPage` is one typed `api.get` with the query it
 * is handed. `getAll` is not used because this loop goes by the `pages` a response
 * reports and nothing else: it runs on past an empty or short page.
 */
export async function allPages<Item>(
  fetchPage: (query: { page: number; page_size: number }) => Promise<{
    data?: Item[];
    pages?: number;
  }>,
): Promise<Item[]> {
  const out: Item[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await fetchPage({ page, page_size: PAGE_SIZE });
    out.push(...(res.data ?? []));
    pages = Math.max(1, Number(res.pages ?? 1));
    page += 1;
    // Bounded: 200 pages of 500 is 100,000 objects, far beyond any account.
  } while (page <= pages && page <= 200);
  return out;
}

/** The `X-Filter` header, which carries a JSON object. */
export function xFilter(filter: object): { headers: Record<string, string> } {
  return { headers: { "X-Filter": JSON.stringify(filter) } };
}

/**
 * A path segment as the plugin has always sent it. Ids reach it unencoded, and a
 * composite id that did not split gives `undefined`, which is written out.
 */
export function segment(value: string | number | undefined): NoSlashString {
  return unencodedSegment(String(value));
}

/**
 * The host's HTTP service where there is one and `fetch` where there is not, with
 * two habits callers rely on: `Content-Type` directly after `Accept`, and a 2xx with
 * no body read as an empty object, so a caller's `res.data` finds nothing rather
 * than throwing.
 */
function transport(http: HttpHostServices | undefined): HttpHostServices {
  const send: HttpHostServices["request"] = http
    ? (req) => http.request(req)
    : async ({ url, method, headers, body }) => {
        const res = await fetch(url, {
          method,
          headers,
          // The client only ever sends JSON text.
          ...(typeof body === "string" ? { body } : {}),
        });
        return { status: res.status, headers: {}, body: await res.text() };
      };
  return {
    request: async (req) => {
      const { Accept: accept, "Content-Type": contentType, ...rest } = req.headers;
      const res = await send({
        ...req,
        headers: {
          ...(accept !== undefined ? { Accept: accept } : {}),
          ...(contentType !== undefined ? { "Content-Type": contentType } : {}),
          ...rest,
        },
      });
      const empty = res.status >= 200 && res.status < 300 && (res.status === 204 || !res.body);
      return empty
        ? { status: 200, headers: {}, body: "{}" }
        : { status: res.status, headers: {}, body: res.body };
    },
  };
}

export function createLinodeApi(config: LinodeApiConfig): LinodeApi {
  const shared: Omit<ApiClientOptions, "baseUrl" | "headers"> = {
    vendor: "Linode",
    http: transport(config.services?.http),
    ...(config.caCert ? { caCert: config.caCert } : {}),
    contentType: "with-body",
    httpError: ({ status, path, body }) => new LinodeApiError(status, path, body),
  };
  const monitorBase = config.monitorBaseUrl ?? LINODE_MONITOR_BASE;
  return {
    ...createApiClient<paths>({
      ...shared,
      baseUrl: config.baseUrl ?? LINODE_API_BASE,
      headers: {
        Accept: "application/json",
        // An empty token sends no Authorization header: the public price
        // endpoints (`/linode/types` and friends) answer anonymously, which is what
        // lets the price catalog work without a connected account.
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
    }),
    monitor: (token) =>
      createApiClient<paths>({
        ...shared,
        baseUrl: monitorBase,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      }),
  };
}

/** Numeric/string id at the end of a host resource id (`acct:type:123`). */
export function trailingId(resourceId: string): string {
  const parts = resourceId.split(":");
  const id = parts.slice(2).join(":") || parts[parts.length - 1];
  if (!id) throw new Error(`Cannot parse resource ID "${resourceId}"`);
  return id;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `"true"`/`"false"` form values to booleans; anything else is "unchanged". */
export function formBool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Comma/newline separated text to a trimmed, de-duplicated list. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
