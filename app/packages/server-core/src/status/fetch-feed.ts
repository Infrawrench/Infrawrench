/**
 * Fetching one provider status feed.
 *
 * Feeds are public (zero credentials, zero rate-limit risk), but the request
 * still leaves through the egress proxy when one is configured, for the same
 * reason workflow fetch does: the poller pod should not be the origin of
 * outbound HTTP (`workflows/fetch.ts` has the full argument). Feed URLs come
 * from plugin manifests — code, not user input — so unlike workflow fetch a
 * deployment without a proxy (local dev, self-hosters outside Kubernetes)
 * falls back to a direct fetch instead of failing.
 */
import { fetchFromWorkflow, isWorkflowFetchConfigured } from "../workflows/fetch.js";

/** Feeds are small (AWS's is ~230 KB); anything bigger is a broken feed. */
const FEED_MAX_BYTES = 5 * 1024 * 1024;
const FEED_TIMEOUT_MS = 20_000;

const FEED_ACCEPT =
  "application/json, application/rss+xml, application/atom+xml, text/xml, application/xml;q=0.9, */*;q=0.8";

/**
 * Decode feed bytes with BOM sniffing. AWS's public health feed is UTF-16 BE
 * with a BOM — a naive UTF-8 decode produces garbage `JSON.parse` chokes on.
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
 * or HTTP failure — the collector records the error against the feed row so
 * a broken feed is diagnosable rather than silently reporting "no incidents".
 */
export async function fetchStatusFeedBody(url: string): Promise<string> {
  if (isWorkflowFetchConfigured()) {
    const response = await fetchFromWorkflow({
      url,
      method: "GET",
      headers: { accept: FEED_ACCEPT },
      timeoutMs: FEED_TIMEOUT_MS,
      maxBytes: FEED_MAX_BYTES,
      redirect: "follow",
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`status feed responded HTTP ${response.status}`);
    }
    return decodeFeedBody(Uint8Array.from(Buffer.from(response.bodyBase64, "base64")));
  }

  // No proxy configured — direct fetch (dev / self-hosted outside k8s).
  const res = await fetch(url, {
    headers: { accept: FEED_ACCEPT },
    redirect: "follow",
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`status feed responded HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > FEED_MAX_BYTES) {
    throw new Error(`status feed body exceeds ${FEED_MAX_BYTES} bytes`);
  }
  return decodeFeedBody(new Uint8Array(buffer));
}
