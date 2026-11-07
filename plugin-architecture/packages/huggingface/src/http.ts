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
 * The Hub and Inference Endpoints are called through the typed clients in
 * `api.ts`; only the router and the Inference Catalog, which neither document
 * covers, go through `hfJson`. Both end in `hfTransport`, which prefers the host
 * HTTP service (bastion routing, custom CA, desktop CORS) and only falls back to
 * global `fetch` without one.
 */
import { restRequest, type HttpHostServices } from "@infrawrench/plugin-base";

export const HUB_BASE = "https://huggingface.co";
export const ENDPOINTS_BASE = "https://api.endpoints.huggingface.cloud";
export const ROUTER_BASE = "https://router.huggingface.co/v1";
export const CATALOG_BASE = "https://endpoints.huggingface.co/api/v1/catalog";

export interface HfContext {
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** An Error carrying the HTTP status, which the poller classifies on. */
export type HfError = Error & { status: number };

export function hfError(status: number, label: string, body: string): HfError {
  const detail = extractMessage(body);
  const hint =
    status === 401
      ? " The access token was rejected: check it has not been revoked."
      : status === 403
        ? " The access token lacks a permission this call needs (fine-grained tokens must be granted it explicitly; an account connected with Hugging Face reaches only the organizations granted at sign-in, and cannot read usage, service accounts or member tokens)."
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
    const parsed: { error?: unknown; message?: unknown } | null = JSON.parse(trimmed);
    const msg = parsed?.error ?? parsed?.message;
    if (typeof msg === "string") return msg;
  } catch {
    // Not JSON: fall through to the raw (truncated) body.
  }
  return trimmed.slice(0, 500);
}

export function statusOf(err: unknown): number | undefined {
  if (err === null || typeof err !== "object" || !("status" in err)) return undefined;
  return typeof err.status === "number" ? err.status : undefined;
}

/** Global `fetch`, for a client with no host service. It never takes a CA. */
const viaFetch: HttpHostServices["request"] = async ({ url, method, headers, body }) => {
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: typeof body === "string" ? body : new Uint8Array(body) } : {}),
  });
  const text = await res.text();
  const resHeaders: Record<string, string> = {};
  res.headers?.forEach?.((value, key) => {
    resHeaders[key] = value;
  });
  return { status: res.status, headers: resHeaders, body: text };
};

/** A 2xx body as `restRequest` should parse it: blank is no body, anything else not JSON a string. */
function jsonOrQuoted(text: string): string {
  if (!text.trim()) return "";
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify(text);
  }
}

/**
 * The host service, or `fetch` without one. These APIs answer some writes with a
 * bare word or nothing but whitespace, and that has never been a failure here.
 */
export function hfTransport(ctx: HfContext): HttpHostServices {
  return {
    request: async (req) => {
      const res = ctx.http ? await ctx.http.request(req) : await viaFetch(req);
      if (res.status < 200 || res.status >= 300) return res;
      return { ...res, body: jsonOrQuoted(res.body) };
    },
  };
}

/** What every request to these APIs sends and does, whichever client makes it. */
export function hfRequestOptions(ctx: HfContext) {
  return {
    vendor: "Hugging Face",
    headers: { Authorization: `Bearer ${ctx.token}`, Accept: "application/json" },
    http: hfTransport(ctx),
    contentType: "with-body" as const,
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
  };
}

/**
 * One request to a route neither document covers. `url` is absolute, `body` is
 * JSON-encoded. Throws {@link HfError} on a non-2xx response.
 */
export async function hfJson<T>(
  ctx: HfContext,
  url: string,
  init: { method?: string; body?: object } = {},
): Promise<T> {
  const answer = await restRequest<T>({
    ...hfRequestOptions(ctx),
    url,
    init: {
      method: init.method ?? "GET",
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    httpError: ({ status, body }) => hfError(status, labelFor(url), body),
  });
  return answer.body;
}

/** What an error names: the path alone, or anything that is not a URL as it came. */
export function labelFor(url: string): string {
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
