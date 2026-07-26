/**
 * The workflow egress proxy.
 *
 * Workflow code runs in a QuickJS isolate inside the `web`/`poller` pods on the
 * GKE cluster. If those pods made a workflow's HTTP requests themselves, the
 * blast radius of `fetch("http://…")` would be the cluster's own network: other
 * pods' Services, the kubelet, the GCP metadata server on 169.254.169.254 (which
 * hands out node credentials to anyone who asks). No amount of URL validation in
 * the pod fully closes that, because validation and the socket live in the same
 * place — a DNS name that resolves to a private address after the check passes
 * is enough to defeat it.
 *
 * So the request is made from somewhere that has no such network. This Worker
 * runs on Cloudflare's edge, entirely outside the cluster and outside the GCP
 * project, and Cloudflare's own fetch cannot route to private address space at
 * all. A workflow that asks for `http://10.0.0.5/` gets a refusal here; if a
 * refusal were somehow missed, the request still lands nowhere useful.
 *
 * The URL checks below are therefore the *first* line of defence, not the only
 * one, which is what lets them be strict — every redirect hop is re-validated
 * rather than trusted because the first hop passed.
 *
 * Contract (POST /fetch, `Authorization: Bearer <PROXY_TOKEN>`):
 *   → { url, method, headers, bodyBase64?, timeoutMs, maxBytes, redirect }
 *   ← 200 { response: { status, statusText, url, headers, bodyBase64, redirected } }
 *   ← 4xx/5xx { error: { code, message } }
 *
 * The caller is `server-core/workflows/fetch.ts`; the request shape is
 * `WorkflowFetchRequest` from @infrawrench/workflow-runtime, already validated
 * there. This Worker re-validates anyway — it is reachable by anyone holding the
 * token, so it can't assume a well-behaved caller.
 */

export interface Env {
  /** Shared secret; the only thing standing between this and an open proxy. */
  PROXY_TOKEN: string;
}

/** How many redirects we'll follow before giving up. */
const MAX_REDIRECTS = 5;

/** Ceilings, mirroring the runtime's. A caller asking for more is clamped. */
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Response headers we don't pass back: they describe a connection that ends
 * here, and `set-cookie` would invite a workflow author to build session state
 * on a proxy that is explicitly stateless.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers a caller may not set (the proxy owns these). */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization-proxy",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Hostnames that name something private by convention rather than by address:
 * cluster DNS, the metadata server's friendly name, mDNS.
 */
const BLOCKED_HOST_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".cluster.local",
  ".svc",
  ".home.arpa",
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes",
  "kubernetes.default",
]);

export class ProxyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * True for an IPv4 literal outside public address space — loopback, RFC 1918,
 * link-local (which is where cloud metadata servers live), CGNAT, multicast,
 * and the reserved top block.
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // Not a valid literal; refuse rather than guess.
  }
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** True for an IPv6 literal that isn't globally routable. */
function isPrivateIpv6(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fe8") || host.startsWith("fe9")) return true; // link-local
  if (host.startsWith("fea") || host.startsWith("feb")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique-local
  // IPv4-mapped (::ffff:10.0.0.1) inherits the v4 verdict.
  const mapped = /::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * Validate one URL — the original request and every redirect hop it takes.
 * Throws {@link ProxyError} rather than returning a boolean so the caller can
 * report *which* rule refused, which is what makes this debuggable from a
 * workflow's run log.
 */
export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProxyError("invalid_url", `Not an absolute URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProxyError("blocked_scheme", `Only http and https are proxied, not ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase();
  if (!host) throw new ProxyError("invalid_url", "URL has no host.");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new ProxyError("blocked_host", `${host} names a private network and is not proxied.`);
  }
  if (host.includes(":") || host.startsWith("[")) {
    if (isPrivateIpv6(host)) {
      throw new ProxyError("blocked_host", `${host} is a private address and is not proxied.`);
    }
  } else if (isIpv4(host) && isPrivateIpv4(host)) {
    throw new ProxyError("blocked_host", `${host} is a private address and is not proxied.`);
  }
  // A bare hostname with no dot can only resolve through a search domain — i.e.
  // something on the resolver's own network, never a public name.
  if (!host.includes(".") && !isIpv4(host)) {
    throw new ProxyError("blocked_host", `${host} is not a public hostname.`);
  }
  return url;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so a multi-MB body doesn't blow the argument limit of apply().
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Read at most `maxBytes` of a response body, failing rather than truncating.
 * A silently truncated body is worse than an error: the workflow would parse
 * half a JSON document and act on it.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ProxyError(
        "body_too_large",
        `Response body exceeded ${maxBytes} bytes. Raise maxBytes (up to ${MAX_RESPONSE_BYTES}) or request less.`,
        502,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface ProxyRequestBody {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  bodyBase64?: unknown;
  timeoutMs?: unknown;
  maxBytes?: unknown;
  redirect?: unknown;
}

function clamp(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Perform the request, following redirects by hand so each hop is validated.
 * `redirect: "manual"` in the incoming request means the caller wants the 3xx
 * itself, which is also the only way to see a redirect we would have refused.
 */
async function proxyFetch(body: ProxyRequestBody): Promise<Response> {
  let url = assertAllowedUrl(String(body.url ?? ""));
  const method = String(body.method ?? "GET").toUpperCase();
  const timeoutMs = clamp(body.timeoutMs, 30_000, MAX_TIMEOUT_MS);
  const maxBytes = clamp(body.maxBytes, 5 * 1024 * 1024, MAX_RESPONSE_BYTES);
  const follow = body.redirect !== "manual";

  const headers = new Headers();
  for (const [name, value] of Object.entries((body.headers ?? {}) as Record<string, string>)) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, String(value));
  }

  const payload =
    body.bodyBase64 === undefined || body.bodyBase64 === null
      ? undefined
      : decodeBase64(String(body.bodyBase64));
  if (payload && payload.byteLength > MAX_REQUEST_BYTES) {
    throw new ProxyError("body_too_large", `Request bodies are limited to ${MAX_REQUEST_BYTES}.`);
  }

  const deadline = AbortSignal.timeout(timeoutMs);
  let redirected = false;

  for (let hop = 0; ; hop++) {
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method,
        headers,
        ...(payload ? { body: payload } : {}),
        redirect: "manual",
        signal: deadline,
      });
    } catch (err) {
      if (deadline.aborted) {
        throw new ProxyError(
          "timeout",
          `Request to ${url.host} timed out after ${timeoutMs}ms.`,
          504,
        );
      }
      throw new ProxyError(
        "request_failed",
        `Request to ${url.host} failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }

    const location = upstream.headers.get("location");
    const isRedirect = upstream.status >= 300 && upstream.status < 400 && location;
    if (!follow || !isRedirect) {
      const bytes = await readCapped(upstream, maxBytes);
      const out: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out[name.toLowerCase()] = value;
      });
      return json(200, {
        response: {
          status: upstream.status,
          statusText: upstream.statusText,
          url: url.toString(),
          headers: out,
          bodyBase64: encodeBase64(bytes),
          redirected,
        },
      });
    }

    if (hop >= MAX_REDIRECTS) {
      throw new ProxyError(
        "too_many_redirects",
        `More than ${MAX_REDIRECTS} redirects from ${url}.`,
      );
    }
    // Re-validate: a public host is free to redirect at the metadata server,
    // and that hop is exactly the one an attacker would aim for.
    url = assertAllowedUrl(new URL(location, url).toString());
    redirected = true;
    await upstream.body?.cancel().catch(() => {});
  }
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Compare tokens without leaking their common prefix through timing. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorize(request: Request, env: Env): void {
  if (!env.PROXY_TOKEN) {
    throw new ProxyError("not_configured", "The proxy has no PROXY_TOKEN set.", 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !tokensMatch(token, env.PROXY_TOKEN)) {
    throw new ProxyError("unauthorized", "Bad or missing proxy token.", 401);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // A liveness check that needs no token, so uptime monitoring doesn't have
    // to hold the secret.
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true });
    }
    if (url.pathname !== "/fetch") return json(404, { error: { code: "not_found" } });
    if (request.method !== "POST") {
      return json(405, { error: { code: "method_not_allowed" } });
    }

    try {
      authorize(request, env);
      let body: ProxyRequestBody;
      try {
        body = (await request.json()) as ProxyRequestBody;
      } catch {
        throw new ProxyError("invalid_body", "Request body must be JSON.");
      }
      return await proxyFetch(body);
    } catch (err) {
      if (err instanceof ProxyError) {
        return json(err.status, { error: { code: err.code, message: err.message } });
      }
      return json(500, {
        error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
      });
    }
  },
};
