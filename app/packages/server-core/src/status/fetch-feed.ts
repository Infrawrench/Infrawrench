/**
 * Fetching one provider status feed.
 *
 * Feeds are public (zero credentials, zero rate-limit risk), but the request
 * still leaves through the egress proxy when one is configured, for the same
 * reason workflow fetch does: the poller pod should not be the origin of
 * outbound HTTP (`workflows/fetch.ts` has the full argument). Feed URLs come
 * from plugin manifests (code, not user input) so unlike workflow fetch a
 * deployment without a proxy (local dev, self-hosters outside Kubernetes)
 * falls back to a direct fetch instead of failing. The same fixed-URL
 * reasoning lets a feed that Cloudflare's network cannot reach skip the proxy
 * (`direct`), from Node only: on the edge a direct fetch is Cloudflare's too.
 */
import { fetchFromWorkflow, isWorkflowFetchConfigured } from "../workflows/fetch.js";

/** Feeds are small (AWS's is ~230 KB); anything bigger is a broken feed. */
const FEED_MAX_BYTES = 5 * 1024 * 1024;
const FEED_TIMEOUT_MS = 20_000;

/**
 * Who is asking. Some status pages sit behind a Cloudflare zone that answers
 * a request with no User-Agent with an empty `202` bot check (Heroku's did,
 * 2026-10-12), which reads as a successful, empty feed.
 */
const FEED_USER_AGENT = "Infrawrench-StatusFeeds/1.0 (+https://infrawrench.com)";

const FEED_ACCEPT =
  "application/json, application/rss+xml, application/atom+xml, text/xml, application/xml;q=0.9, */*;q=0.8";

/**
 * Decode feed bytes with BOM sniffing. AWS's public health feed is UTF-16 BE
 * with a BOM: a naive UTF-8 decode produces garbage `JSON.parse` chokes on.
 * BOM handling is generic text decoding, not provider knowledge, so it lives
 * here rather than in any plugin.
 */
export function decodeFeedBody(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  // TextDecoder("utf-8") strips a UTF-8 BOM itself.
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Fetch a status feed and return its decoded body. Throws on any transport
 * or HTTP failure: the collector records the error against the feed row so
 * a broken feed is diagnosable rather than silently reporting "no incidents".
 */
export async function fetchStatusFeedBody(
  url: string,
  options: { direct?: boolean } = {},
): Promise<string> {
  return fetchPublicFeedBody(url, {
    accept: FEED_ACCEPT,
    userAgent: FEED_USER_AGENT,
    timeoutMs: FEED_TIMEOUT_MS,
    maxBytes: FEED_MAX_BYTES,
    label: "status feed",
    ...(options.direct ? { direct: true } : {}),
  });
}

/** Options for {@link fetchPublicFeedBody}. */
export interface PublicFeedFetchOptions {
  accept: string;
  timeoutMs: number;
  maxBytes: number;
  /** Prefix for error messages, e.g. "status feed". */
  label: string;
  /** Sent as `User-Agent`; without one, some origins answer a bot check. */
  userAgent?: string;
  /**
   * Fetch from this process even when the egress proxy is configured: for a
   * fixed URL the proxy's network cannot reach (see
   * `StatusFeedDeclaration.reachableFromEdge`). The URL must come from code,
   * never from user input; the proxy exists for the URLs that do.
   */
  direct?: boolean;
}

/** A 2xx with nothing in it is a bot check or a broken feed, never a feed. */
function assertNotEmpty(bytes: Uint8Array, status: number, label: string): void {
  if (bytes.byteLength === 0) {
    throw new Error(`${label} responded HTTP ${status} with an empty body`);
  }
}

/**
 * Fetch a public, credential-free document (a status feed, a published
 * reference-rate file) through the egress proxy when one is configured, or
 * directly otherwise, with a hard size cap. Shared by the status-feed pass and
 * the exchange-rate feed pass (`cost/fx-feed-pass.ts`).
 */
export async function fetchPublicFeedBody(
  url: string,
  options: PublicFeedFetchOptions,
): Promise<string> {
  const { accept, timeoutMs, maxBytes, label, userAgent } = options;
  const headers: Record<string, string> = {
    accept,
    ...(userAgent ? { "user-agent": userAgent } : {}),
  };
  if (isWorkflowFetchConfigured() && !options.direct) {
    const response = await fetchFromWorkflow({
      url,
      method: "GET",
      headers,
      timeoutMs,
      maxBytes,
      redirect: "follow",
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${label} responded HTTP ${response.status}`);
    }
    const bytes = Uint8Array.from(Buffer.from(response.bodyBase64, "base64"));
    assertNotEmpty(bytes, response.status, label);
    return decodeFeedBody(bytes);
  }

  // Direct: no proxy configured (dev / self-hosted outside k8s), or a feed
  // the proxy's network cannot reach.
  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${label} responded HTTP ${res.status}`);
  }
  // Stream with an early abort so a runaway feed never buffers past the cap.
  // Content-Length is only a hint (may be absent or wrong).
  const advertised = res.headers.get("content-length");
  if (advertised && Number(advertised) > maxBytes) {
    throw new Error(`${label} body exceeds ${maxBytes} bytes`);
  }
  if (!res.body) {
    throw new Error(`${label} response has no body`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  if (total === 0) assertNotEmpty(buffer, res.status, label);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeFeedBody(buffer);
}
