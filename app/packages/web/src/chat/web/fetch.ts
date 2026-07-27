/**
 * `web_fetch` for the chat agent: retrieve one URL and hand its text to the
 * model.
 *
 * The request goes through the egress proxy
 * (`app/packages/egress-proxy`, client in
 * `@infrawrench/server-core/workflows/fetch`) rather than leaving from the web
 * pod. That proxy was built for workflow `fetch()`, and its README warns against
 * reusing it for the app's own server-side HTTP — but the warning is about
 * traffic to fixed, known hosts (provider APIs, Slack, Twilio), where a hop
 * through Cloudflare adds latency and a failure mode for no benefit. This is the
 * opposite case and the one the Worker exists for: the destination is chosen by
 * a language model, from a conversation that may itself contain text written by
 * a stranger. From inside the cluster that is a request to `169.254.169.254`
 * away from leaking node credentials, and in-pod URL validation cannot close it
 * because a hostname can resolve to a private address after the check passes.
 *
 * Consequences of routing through the proxy, all of them wanted here: private,
 * loopback, link-local, CGNAT and cluster-internal addresses are refused; every
 * redirect hop is re-validated; `set-cookie` is stripped; the response is capped
 * and *errors* rather than truncating.
 *
 * The tool is GET-only by construction — no method, headers, or body parameter
 * exists — so it cannot be turned into a way to POST to an internal-ish webhook,
 * and it stays honestly a `read` for the approval flow.
 */
import {
  fetchFromWorkflow,
  isWorkflowFetchConfigured,
} from "@infrawrench/server-core/workflows/fetch";
import { htmlToMarkdown, extractTitle, decodeEntities } from "./html-to-markdown";

/**
 * Characters of page text handed to the model. Claude Code allows 100k; this is
 * lower because the text lands in a conversation that already carries ~150kb of
 * tool schemas plus history, and every later turn re-reads it.
 */
export const MAX_CONTENT_CHARS = 40_000;

/** Response bytes accepted from the proxy, before decoding. */
const MAX_BYTES = 5 * 1024 * 1024;

const TIMEOUT_MS = 20_000;

export interface FetchedPage {
  url: string;
  title: string | null;
  contentType: string;
  text: string;
  truncated: boolean;
  status: number;
}

export function isWebFetchConfigured(): boolean {
  return isWorkflowFetchConfigured();
}

/** Reject non-http(s) before the proxy does, for a clearer message. */
export function validateFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be fetched (got ${url.protocol})`);
  }
  return url;
}

function charsetOf(contentType: string): string {
  const match = /charset=["']?([\w-]+)/i.exec(contentType);
  const label = match?.[1]?.toLowerCase();
  // Node's TextDecoder knows the WHATWG label set; anything else falls back to
  // UTF-8 rather than throwing on a page with a typo'd charset.
  if (!label) return "utf-8";
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return "utf-8";
  }
}

function toText(
  bodyBase64: string,
  contentType: string,
  url: string,
): { text: string; title: string | null } {
  const bytes = Buffer.from(bodyBase64, "base64");
  const decoded = new TextDecoder(charsetOf(contentType)).decode(bytes);
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (type === "text/html" || type === "application/xhtml+xml") {
    return { text: htmlToMarkdown(decoded, url), title: extractTitle(decoded) };
  }
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      return { text: JSON.stringify(JSON.parse(decoded), null, 2), title: null };
    } catch {
      return { text: decoded, title: null };
    }
  }
  // Plain text, markdown, CSV, XML, source files: pass through, only decoding
  // entities for XML-ish payloads where they'd otherwise read as noise.
  if (type.endsWith("+xml") || type === "text/xml" || type === "application/xml") {
    return { text: decodeEntities(decoded), title: null };
  }
  return { text: decoded, title: null };
}

const BINARY_HINT = /^(image|audio|video|font)\//i;

export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  const url = validateFetchUrl(rawUrl);

  const response = await fetchFromWorkflow({
    url: url.toString(),
    method: "GET",
    headers: {
      // Identify ourselves. Sites that block unknown agents will still block
      // us, but they can see who we are and the operator has something to
      // point at in their logs.
      "user-agent": "Infrawrench-Chat/1.0 (+https://infrawrench.com)",
      accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
      "accept-language": "en",
    },
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_BYTES,
    redirect: "follow",
  });

  const contentType = response.headers["content-type"] ?? "";
  if (BINARY_HINT.test(contentType)) {
    throw new Error(
      `${url.toString()} is ${contentType.split(";")[0]} — this tool reads text, not binary content.`,
    );
  }

  const { text, title } = toText(response.bodyBase64, contentType, response.url || url.toString());
  const truncated = text.length > MAX_CONTENT_CHARS;

  return {
    url: response.url || url.toString(),
    title,
    contentType: contentType.split(";")[0]?.trim() ?? "",
    text: truncated ? text.slice(0, MAX_CONTENT_CHARS) : text,
    truncated,
    status: response.status,
  };
}
