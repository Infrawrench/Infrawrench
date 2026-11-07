import { defineCredential } from "./define-plugin.js";
/**
 * Shared HTTP helpers for plugin clients.
 *
 * Most REST-based plugin clients (DigitalOcean, Hetzner, Fly, Neon, Turso,
 * Netlify, Vercel, PlanetScale, Cloudinary, Scaleway, …) implement an
 * identical private `fetch<T>()` method that only varies in the vendor
 * label used in error messages and the set of auth headers it sends.
 *
 * `jsonRestFetch` factors that pattern out. Plugins still own their
 * baseUrl and auth scheme: they pass a pre-built headers object in and
 * a vendor label for error text.
 *
 * Plugins with response envelopes (e.g. Cloudflare's `{success,result}`)
 * or custom signing (e.g. OVH's HMAC, AWS SigV4) keep their own helpers.
 */

import type { CredentialField, HttpHostServices } from "./manifest.js";

/**
 * Optional CA-bundle credential plugins can include in their manifest when
 * they make HTTPS calls to a configurable vendor endpoint (e.g. self-hosted
 * Databricks workspace) or sit behind a corporate TLS-intercepting proxy.
 *
 * Empty value → falls back to the OS trust store via the global `fetch`.
 * Non-empty value → request is routed through the Node host's `https` agent
 * with the supplied PEM as the only trust anchor.
 */
export const caCertCredentialField = defineCredential({
  key: "caCert",
  label: "CA Certificate (optional)",
  description:
    "PEM-encoded trust anchor for verifying the API endpoint. Use this for self-hosted vendor instances or corporate TLS-intercepting proxies. Leave blank to use the operating system's default trust store.",
  sensitive: false,
  optional: true,
  advanced: true,
  multiline: true,
  placeholder: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----",
});

export interface JsonRestFetchOptions {
  /** Vendor name used in the error message, e.g. `"DigitalOcean"`. */
  vendor: string;
  /** Fully-qualified URL. Plugins usually compose this from `baseUrl + path`. */
  url: string;
  /** Auth / content headers. Merged on top of a default `Content-Type: application/json`. */
  headers: Record<string, string>;
  /**
   * Optional short path for the error message so vendors can report
   * `"for /v2/droplets"` rather than the full URL.
   */
  errorPath?: string;
  /**
   * Forwarded to `fetch` (method, body, signal, etc.). If `init.headers` is set,
   * it is merged on top of `headers` (so call-site overrides auth headers).
   */
  init?: RequestInit;
  /**
   * PEM-encoded CA certificate(s) to pin against the server's leaf chain.
   * When set together with `http`, the request is routed through the host
   * process's `https` agent so the custom trust anchor is honored. Use this
   * for self-hosted / on-prem vendor endpoints (e.g. private Databricks
   * workspace) or corporate TLS-intercepting proxies. Empty / missing falls
   * back to the OS trust store via the global `fetch`.
   */
  caCert?: string;
  /**
   * Host-provided HTTP service. Required for `caCert` to take effect; the
   * renderer (browser) cannot install a custom trust anchor on its own and
   * has to proxy through the Node host.
   */
  http?: HttpHostServices;
}

export interface RestRequestOptions extends JsonRestFetchOptions {
  /** Build what a non-2xx answer throws, instead of the default `Error`. */
  httpError?: (failure: { status: number; body: string }) => Error;
  /**
   * `"always"` (default) puts `Content-Type: application/json` first on every
   * request. `"with-body"` sends it only on a request with a body, after the
   * caller's headers, and not at all when the caller set one.
   */
  contentType?: "always" | "with-body";
  /** What `contentType` declares the body to be. `application/json` by default. */
  bodyType?: string;
  /**
   * Read a 2xx with no body as `undefined` under global `fetch` too. The host's
   * HTTP service has always done that; `fetch` throws a `SyntaxError` by default.
   */
  emptyBodyIsUndefined?: boolean;
  /** `"text"` returns the body as it came, whatever its status or content type. */
  responseAs?: "json" | "text";
}

/** An answer with what `jsonRestFetch` drops. Header names are lower case in both transports. */
export interface RestResponse<T> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

function lowerCaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  // Plenty of plugin tests stub `fetch` with a bare `{ ok, json }`.
  res.headers?.forEach?.((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function mergeHeaders(opts: RestRequestOptions): Record<string, string> {
  const initHeaders = opts.init?.headers;
  const merged: Record<string, string> =
    opts.contentType === "with-body"
      ? { ...opts.headers }
      : { "Content-Type": opts.bodyType ?? "application/json", ...opts.headers };
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        merged[key] = value;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) merged[key] = value;
    } else {
      Object.assign(merged, initHeaders);
    }
  }
  if (
    opts.contentType === "with-body" &&
    opts.init?.body != null &&
    !Object.keys(merged).some((key) => key.toLowerCase() === "content-type")
  ) {
    merged["Content-Type"] = opts.bodyType ?? "application/json";
  }
  return merged;
}

/**
 * One REST request, answered with its status and headers as well as the parsed
 * body. {@link jsonRestFetch} is this, for callers that only want the body.
 */
export async function restRequest<T>(opts: RestRequestOptions): Promise<RestResponse<T>> {
  const { vendor, url, errorPath, init, caCert, http, httpError, responseAs } = opts;
  const mergedHeaders = mergeHeaders(opts);
  const failed = (status: number, body: string) =>
    httpError?.({ status, body }) ??
    new Error(`${vendor} API error ${status} for ${errorPath ?? url}: ${body}`);

  // Always prefer the host's HTTP service when present: that's the only path
  // that picks up bastion routing for accounts that have one attached, and the
  // only path that honors a custom CA. Fall back to direct fetch when there is
  // no host (browser/renderer paths, tests).
  if (http) {
    const body = bodyForHostHttp(init?.body);
    const result = await untilAborted(
      http.request({
        url,
        method: init?.method ?? "GET",
        headers: mergedHeaders,
        ...(body !== undefined ? { body } : {}),
        ...(caCert ? { caCert } : {}),
      }),
      init?.signal,
    );
    if (result.status < 200 || result.status >= 300) throw failed(result.status, result.body);
    const answer = { status: result.status, headers: lowerCaseKeys(result.headers) };
    if (responseAs === "text") return { ...answer, body: result.body as T };
    if (result.status === 204 || !result.body) return { ...answer, body: undefined as T };
    return { ...answer, body: JSON.parse(result.body) as T };
  }

  const res = await fetch(url, { ...init, headers: mergedHeaders });
  if (!res.ok) throw failed(res.status, await res.text());
  const answer = { status: res.status, headers: headersOf(res) };
  if (responseAs === "text") return { ...answer, body: (await res.text()) as T };
  if (res.status === 204) return { ...answer, body: undefined as T };
  if (opts.emptyBodyIsUndefined) {
    const text = await res.text();
    return { ...answer, body: (text ? JSON.parse(text) : undefined) as T };
  }
  return { ...answer, body: (await res.json()) as T };
}

/**
 * JSON-over-REST fetch helper. Returns the parsed JSON body typed as `T`.
 *
 * - Throws `Error("<vendor> API error <status> for <path>: <body>")` on !ok.
 * - Returns `undefined as T` for 204 No Content (matches existing per-plugin behavior).
 * - `Content-Type: application/json` is set unless the caller supplied one.
 */
export async function jsonRestFetch<T>(opts: JsonRestFetchOptions): Promise<T> {
  return (await restRequest<T>(opts)).body;
}

/** How a plugin reaches its provider, from `services?.http` and its `caCert` credential. */
export interface HostTransport {
  http?: HttpHostServices | undefined;
  /** An empty string means none. */
  caCert?: string | undefined;
}

/**
 * The transport as `restRequest` and `jsonRestFetch` take it. Every provider call goes
 * through the host's service when there is one, because that is the only path with
 * bastion routing, and `caCert` only goes along when it is set:
 *
 *   jsonRestFetch({ vendor, url, headers, ...hostTransport(services?.http, caCert) });
 *
 * `createApiClient` takes `http` and `caCert` as they are, empty or not.
 */
export function hostTransport(
  http: HttpHostServices | undefined,
  caCert?: string,
): { http?: HttpHostServices; caCert?: string } {
  return { ...(http ? { http } : {}), ...(caCert ? { caCert } : {}) };
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

/** What `HttpHostServices` carries: a text or byte body, and a type a `FormData` chose for itself. */
async function encodedBody(
  body: BodyInit | null | undefined,
): Promise<{ body?: string | Uint8Array; contentType?: string }> {
  if (body == null) return {};
  if (typeof body === "string") return { body };
  if (body instanceof Uint8Array) return { body };
  const encoded = new Request("https://encode.invalid", { method: "POST", body });
  const contentType = encoded.headers.get("content-type");
  return {
    body: new Uint8Array(await encoded.arrayBuffer()),
    ...(contentType ? { contentType } : {}),
  };
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * `fetch`, through the host's service when there is one, so a binary answer, a
 * multipart upload or a signed URL still gets bastion routing and a custom CA:
 *
 *   const res = await hostFetch({ http: services?.http, caCert }, url, init);
 *   const audio = await res.arrayBuffer();
 *
 * It answers a real `Response`, so what follows does not change. Global `fetch` is
 * only for when there is no host. `stream: true` is for an answer that must arrive as
 * it is written (`res.body`): a host that cannot stream one falls back to `fetch`,
 * unless a custom CA needs the host, which then buffers it.
 */
export async function hostFetch(
  transport: HostTransport & { stream?: boolean },
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const { http, caCert, stream } = transport;
  const streams = stream && http?.requestStream;
  if (!http || (stream && !streams && !caCert)) return fetch(url, init);

  const { body, contentType } = await encodedBody(init.body);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (contentType && !headers["content-type"]) headers["content-type"] = contentType;
  const request = {
    url,
    method: init.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(caCert ? { caCert } : {}),
  };
  if (streams && http.requestStream) {
    const answer = await untilAborted(http.requestStream(request), init.signal);
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  }
  const answer = await untilAborted(
    http.request({ ...request, responseEncoding: "binary" }),
    init.signal,
  );
  // `slice` for the type: `Response` will not take a view that may be over shared memory.
  const payload = answer.rawBody?.slice() ?? answer.body;
  return new Response(NULL_BODY_STATUSES.has(answer.status) ? null : payload, {
    status: answer.status,
    headers: answer.headers,
  });
}

/**
 * Normalise the variety of `BodyInit` types `fetch` accepts down to what
 * `HttpHostServices.request` expects (string | Uint8Array | undefined).
 * Streams and FormData are not supported: control-plane plugins should not
 * be using them through this helper.
 */
function bodyForHostHttp(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  // Anything else (Blob, FormData, ReadableStream, URLSearchParams): coerce
  // to string. URLSearchParams.toString() matches form-urlencoded semantics
  // and is the only one of these we realistically see in plugin control planes.
  return String(body);
}

/**
 * Format a byte count as a human-readable string using binary (1024-based) units.
 * Examples: `0` → "0 B", `1024` → "1.0 KB", `1572864` → "1.5 MB".
 *
 * Used by the Cloudinary plugin. Plugins with different unit or precision
 * rules (e.g. GCP's `formatBackupSize` adds a PB unit and parses string
 * inputs, memcached's short form, OpenSearch's dynamic precision) keep their
 * own.
 */
export function formatBytes(bytes: number): string {
  // Garbage (NaN, negative, infinite) reads as nothing rather than "NaN undefined".
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
