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
}

/**
 * JSON-over-REST fetch helper. Returns the parsed JSON body typed as `T`.
 *
 * - Throws `Error("<vendor> API error <status> for <path>: <body>")` on !ok.
 * - Returns `undefined as T` for 204 No Content (matches existing per-plugin behavior).
 * - `Content-Type: application/json` is set unless the caller supplied one.
 */
export async function jsonRestFetch<T>(opts: JsonRestFetchOptions): Promise<T> {
  const { vendor, url, headers, errorPath, init } = opts;
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
  const res = await fetch(url, { ...init, headers: mergedHeaders });
  if (!res.ok) {
    const label = errorPath ?? url;
    throw new Error(`${vendor} API error ${res.status} for ${label}: ${await res.text()}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/**
 * Format a byte count as a human-readable string using binary (1024-based) units.
 * Examples: `0` → "0 B", `1024` → "1.0 KB", `1572864` → "1.5 MB".
 *
 * Canonical shape shared by Azure, Cloudinary, and GCP plugins. Plugins with
 * different precision rules (e.g. AWS's PB handling, memcached's short form)
 * keep their own.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
