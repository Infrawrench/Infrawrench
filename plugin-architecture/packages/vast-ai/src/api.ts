import {
  createApiClient,
  type HostServices,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * Transport for the Vast.ai REST API (`https://console.vast.ai/api/v0`, plus
 * `/api/v1` for the paginated instance and invoice lists). Verified 2026-10
 * against the published OpenAPI document
 * (`https://docs.vast.ai/api-reference/openapi.yaml`) and the `vast-cli`
 * source. Auth is `Authorization: Bearer <key>`. Errors are usually
 * `{success: false, error, msg}`, sometimes only `msg`/`message`, and a rate
 * limit is a 429 whose body may be plain text.
 */

export const API_ORIGIN = "https://console.vast.ai";

export class VastApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Vast.ai API error ${status} for ${path}: ${summarize(body)}`);
    this.name = "VastApiError";
    this.status = status;
    this.body = body;
  }
}

export function summarize(body: string): string {
  try {
    const p: unknown = JSON.parse(body);
    if (typeof p === "object" && p !== null) {
      for (const name of ["msg", "message", "error"]) {
        const v: unknown = Reflect.get(p, name);
        if (typeof v === "string" && v) return v;
      }
    }
  } catch {
    /* plain text */
  }
  return body.slice(0, 500) || "(empty response)";
}

/** Every route Vast serves ends in a slash, which its document leaves off. */
type Slashed<P> = { [K in keyof P & string as `${K}/`]: P[K] };

/** Objects are JSON-encoded, which is how Vast reads `select_filters` and friends. */
function writeQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return params.toString();
}

/** Some endpoints answer 200 with `success: false`. */
function saysFailure(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "success" in parsed &&
      parsed.success === false
    );
  } catch {
    return false;
  }
}

type HttpRequest = Parameters<HttpHostServices["request"]>[0];

async function requestWithFetch(req: HttpRequest) {
  const { url, method, headers, body } = req;
  // Every body this client sends is JSON text.
  const res = await fetch(url, { method, headers, ...(typeof body === "string" ? { body } : {}) });
  return { status: res.status, headers: {}, body: await res.text() };
}

/**
 * The host's HTTP service, or `fetch` where there is none. It sits under the client
 * because a soft failure's error carries the body as it came, and only the transport
 * sees that: as a 400 here, it reaches `httpError` like any other failure.
 */
function vastTransport(services: HostServices | undefined): HttpHostServices {
  return {
    request: async (req) => {
      const http = services?.http;
      const res = http ? await http.request(req) : await requestWithFetch(req);
      const body = res.body ?? "";
      const soft = res.status >= 200 && res.status < 300 && saysFailure(body);
      return { ...res, body, status: soft ? 400 : res.status };
    },
  };
}

/** A client over `/api/v0` and `/api/v1`; each path includes its version prefix. */
export function createVastApi(apiKey: string, caCert: string, services: HostServices | undefined) {
  return createApiClient<Slashed<paths>>({
    vendor: "Vast.ai",
    baseUrl: API_ORIGIN,
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    http: vastTransport(services),
    caCert,
    contentType: "with-body",
    serializeQuery: writeQuery,
    httpError: ({ status, path, body }) => new VastApiError(status, path, body),
  });
}

export type VastApi = ReturnType<typeof createVastApi>;

const MAX_PAGES = 200;

/**
 * Keyset pagination: `after_token` in, `next_token` out. A hand loop rather than
 * `getAll`, which reads a list that is not an array as empty: here that throws, so a
 * malformed answer fails the sync instead of pruning what it no longer lists.
 */
export async function collectPages<Page extends { next_token?: string | null }, Item>(
  fetchPage: (after: { after_token?: string }) => Promise<Page>,
  list: (page: Page | undefined) => Iterable<Item> | undefined,
): Promise<Item[]> {
  const out: Item[] = [];
  let after_token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: Page | undefined = await fetchPage(after_token ? { after_token } : {});
    out.push(...(list(res) ?? []));
    after_token = res?.next_token || undefined;
    if (!after_token) break;
  }
  return out;
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof VastApiError && statuses.includes(err.status);
}
