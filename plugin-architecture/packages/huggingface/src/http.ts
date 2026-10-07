/**
 * HTTP layer for the Hugging Face plugin.
 *
 * Three hosts are involved, all authenticated with the same user access token
 * as `Authorization: Bearer hf_…`:
 *
 * - `https://huggingface.co/api/…`: the Hub (repos, Spaces, Jobs, org
 *   settings, billing). Spec: https://huggingface.co/.well-known/openapi.json
 * - `https://api.endpoints.huggingface.cloud/v2/…`: Inference Endpoints.
 *   Spec: https://api.endpoints.huggingface.cloud/openapi.json
 * - `https://router.huggingface.co/v1/…`: the Inference Providers router
 *   (OpenAI-compatible).
 *
 * The Hub paginates with an RFC 8288 `Link: <…>; rel="next"` header, so this
 * helper returns response headers, which `jsonRestFetch` does not. It still
 * prefers the host HTTP service (bastion routing, custom CA, desktop CORS) and
 * only falls back to global `fetch` without one.
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";

export const HUB_BASE = "https://huggingface.co";
export const ENDPOINTS_BASE = "https://api.endpoints.huggingface.cloud";
export const ROUTER_BASE = "https://router.huggingface.co/v1";
export const CATALOG_BASE = "https://endpoints.huggingface.co/api/v1/catalog";

export interface HfContext {
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

export interface HfResponse<T> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

/** An Error carrying the HTTP status, which the poller classifies on. */
export type HfError = Error & { status: number };

export function hfError(status: number, label: string, body: string): HfError {
  const detail = extractMessage(body);
  const hint =
    status === 401
      ? " The access token was rejected: check it has not been revoked."
      : status === 403
        ? " The access token lacks a permission this call needs (fine-grained tokens must be granted it explicitly)."
        : "";
  const err = new Error(
    `Hugging Face API error ${status} for ${label}${detail ? `: ${detail}` : ""}${hint}`,
  );
  return Object.assign(err, { status });
}

function extractMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const msg = parsed.error ?? parsed.message;
    if (typeof msg === "string") return msg;
  } catch {
    // Not JSON: fall through to the raw (truncated) body.
  }
  return trimmed.slice(0, 500);
}

export function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Perform one request. `url` is absolute. `body` is JSON-encoded when it is
 * not already a string. Throws {@link HfError} on a non-2xx response.
 */
export async function hfRequest<T>(
  ctx: HfContext,
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<HfResponse<T>> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.token}`,
    Accept: "application/json",
    ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...init.headers,
  };
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === "string"
        ? init.body
        : JSON.stringify(init.body);
  const label = labelFor(url);

  let status: number;
  let text: string;
  let resHeaders: Record<string, string>;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    status = res.status;
    text = res.body;
    resHeaders = lowerKeys(res.headers);
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    text = await res.text();
    resHeaders = {};
    res.headers?.forEach?.((value, key) => {
      resHeaders[key.toLowerCase()] = value;
    });
  }

  if (status < 200 || status >= 300) throw hfError(status, label, text);
  if (status === 204 || !text.trim()) {
    return { status, headers: resHeaders, data: undefined as unknown as T };
  }
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = text as unknown as T;
  }
  return { status, headers: resHeaders, data };
}

/** Convenience wrapper returning only the parsed body. */
export async function hfJson<T>(
  ctx: HfContext,
  url: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  return (await hfRequest<T>(ctx, url, init)).data;
}

/**
 * Follow `Link: rel="next"` pages until exhausted or `maxPages` is reached.
 * Hub listings return a bare JSON array per page.
 */
export async function hfPaginate<T>(ctx: HfContext, url: string, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  for (let page = 0; next && page < maxPages; page++) {
    const res: HfResponse<T[] | null> = await hfRequest<T[] | null>(ctx, next);
    if (Array.isArray(res.data)) out.push(...res.data);
    next = parseNextLink(res.headers["link"]);
  }
  return out;
}

/** Extract the `rel="next"` target from an RFC 8288 Link header. */
export function parseNextLink(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;(.*)$/.exec(part.trim());
    if (match && /rel="?next"?/.test(match[2] ?? "")) return match[1];
  }
  return undefined;
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}

function labelFor(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return url;
  }
}

/** Encode a `namespace/name` repo id for a path, keeping the slash. */
export function encRepo(repoId: string): string {
  return repoId.split("/").map(encodeURIComponent).join("/");
}

export function enc(value: string): string {
  return encodeURIComponent(value);
}
