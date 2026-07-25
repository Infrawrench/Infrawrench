/**
 * Shared HTTP helpers for plugin clients.
 *
 * Most REST-based plugin clients (DigitalOcean, Hetzner, Fly, Neon, Turso,
 * Netlify, Vercel, PlanetScale, Cloudinary, Scaleway, …) implement an
 * identical private `fetch<T>()` method that only varies in the vendor
 * label used in error messages and the set of auth headers it sends.
 *
 * `jsonRestFetch` factors that pattern out. Plugins still own their
 * baseUrl and auth scheme — they pass a pre-built headers object in and
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
export const caCertCredentialField: CredentialField = {
  key: "caCert",
  label: "CA Certificate (optional)",
  description:
    "PEM-encoded trust anchor for verifying the API endpoint. Use this for self-hosted vendor instances or corporate TLS-intercepting proxies. Leave blank to use the operating system's default trust store.",
  sensitive: false,
  optional: true,
  multiline: true,
  placeholder: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----",
};

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

/**
 * JSON-over-REST fetch helper. Returns the parsed JSON body typed as `T`.
 *
 * - Throws `Error("<vendor> API error <status> for <path>: <body>")` on !ok.
 * - Returns `undefined as T` for 204 No Content (matches existing per-plugin behavior).
 * - `Content-Type: application/json` is set unless the caller supplied one.
 */
export async function jsonRestFetch<T>(opts: JsonRestFetchOptions): Promise<T> {
  const { vendor, url, headers, errorPath, init, caCert, http } = opts;
  const initHeaders = init?.headers;
  const mergedHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        mergedHeaders[key] = value;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) mergedHeaders[key] = value;
    } else {
      Object.assign(mergedHeaders, initHeaders);
    }
  }

  // Always prefer the host's HTTP service when present — that's the only path
  // that picks up bastion routing for accounts that have one attached, and the
  // only path that honors a custom CA. Fall back to direct fetch when there is
  // no host (browser/renderer paths, tests).
  if (http) {
    const body = bodyForHostHttp(init?.body);
    const result = await http.request({
      url,
      method: init?.method ?? "GET",
      headers: mergedHeaders,
      ...(body !== undefined ? { body } : {}),
      ...(caCert ? { caCert } : {}),
    });
    if (result.status < 200 || result.status >= 300) {
      const label = errorPath ?? url;
      throw new Error(`${vendor} API error ${result.status} for ${label}: ${result.body}`);
    }
    if (result.status === 204 || !result.body) return undefined as unknown as T;
    return JSON.parse(result.body) as T;
  }

  const res = await fetch(url, { ...init, headers: mergedHeaders });
  if (!res.ok) {
    const label = errorPath ?? url;
    throw new Error(`${vendor} API error ${res.status} for ${label}: ${await res.text()}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/**
 * Normalise the variety of `BodyInit` types `fetch` accepts down to what
 * `HttpHostServices.request` expects (string | Uint8Array | undefined).
 * Streams and FormData are not supported — control-plane plugins should not
 * be using them through this helper.
 */
function bodyForHostHttp(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  // Anything else (Blob, FormData, ReadableStream, URLSearchParams) — coerce
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
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
