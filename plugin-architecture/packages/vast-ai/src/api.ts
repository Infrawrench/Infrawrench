import {
  createApiClient,
  withCursorPagination,
  type HostServices,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * Transport for the Vast.ai REST API (`https://console.vast.ai/api/v0`, plus
 * `/api/v1` for the paginated instances and for template edits). Verified 2026-10
 * against the published OpenAPI document
 * (`https://docs.vast.ai/api-reference/openapi.yaml`) and the `vast-cli`
 * source. Auth is `Authorization: Bearer <key>`. Errors are usually
 * `{success: false, error, msg}`, sometimes only `msg`/`message`, and a rate
 * limit is a 429 whose body may be plain text.
 */

export const API_ORIGIN = "https://console.vast.ai";
export const VENDOR = "Vast.ai";

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

/** 10,000 instances at Vast's limit of 25 a page; the charge pages hold 500. */
const MAX_PAGES = 400;

/** A client over `/api/v0` and `/api/v1`; each path includes its version prefix. */
export function createVastApi(apiKey: string, caCert: string, services: HostServices | undefined) {
  return withCursorPagination(
    createApiClient<Slashed<paths>>({
      vendor: VENDOR,
      baseUrl: API_ORIGIN,
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      http: vastTransport(services),
      caCert,
      contentType: "with-body",
      serializeQuery: writeQuery,
      httpError: ({ status, path, body }) => new VastApiError(status, path, body),
    }),
    {
      cursorParam: "after_token",
      next: "next_token",
      sizeParam: "limit",
      maxPages: MAX_PAGES,
      // The document ends both paged lists on a null `next_token`, not on an empty page.
      continueOnEmptyPage: true,
    },
  );
}

export type VastApi = ReturnType<typeof createVastApi>;

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof VastApiError && statuses.includes(err.status);
}
