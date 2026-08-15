/**
 * Deciding whether a caller wants markdown instead of HTML.
 *
 * The audience is an agent that found infrawrench.com and would rather read
 * prose than parse a Tailwind DOM. Rather than making it guess at a URL
 * convention, the same URLs answer in markdown when asked — with `.md` twins
 * and `/llms.txt` as the discoverable fallback for the pages that are
 * prerendered and never reach this code.
 */

/** One entry of an `Accept` header, after parsing. */
interface AcceptEntry {
  type: string;
  q: number;
}

/**
 * Parse an `Accept` header into type/quality pairs.
 *
 * Parameters other than `q` are ignored rather than matched on: `text/markdown;
 * variant=GFM` is still a request for markdown, and treating an unknown
 * parameter as a different media type would answer HTML to a caller that asked
 * politely and specifically.
 */
function parseAccept(header: string): AcceptEntry[] {
  return header
    .split(",")
    .map((part) => {
      const [rawType, ...params] = part.split(";");
      const type = rawType?.trim().toLowerCase();
      if (!type) return null;
      let q = 1;
      for (const param of params) {
        const [key, value] = param.split("=");
        if (key?.trim().toLowerCase() !== "q") continue;
        const parsed = Number.parseFloat(value ?? "");
        // A malformed q is not a reason to drop the entry — RFC 9110 says
        // treat it as 1, and an agent that mistypes a weight still meant to
        // ask for the type.
        q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 1;
      }
      return { type, q };
    })
    .filter((e): e is AcceptEntry => e !== null);
}

const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown", "text/plain"]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * True when the caller would rather have markdown than HTML.
 *
 * Strictly comparative, and deliberately so. A browser sends
 * `text/html,application/xhtml+xml,application/xml;q=0.9,*​/*;q=0.8` — the
 * wildcard matches markdown, so "does it accept markdown" is true for every
 * browser alive and would serve plain text to the whole web. The question that
 * gives the right answer is "does it accept markdown *more* than HTML", and a
 * wildcard is not a preference for either.
 *
 * `text/plain` counts. Terminal clients (`curl -H 'Accept: text/plain'`, some
 * agent HTTP wrappers) mean the same thing by it here, and markdown is valid
 * plain text.
 */
export function prefersMarkdown(acceptHeader: string | null | undefined): boolean {
  if (!acceptHeader) return false;
  const entries = parseAccept(acceptHeader);

  let markdown = 0;
  let html = 0;
  for (const { type, q } of entries) {
    if (q === 0) continue;
    if (MARKDOWN_TYPES.has(type)) markdown = Math.max(markdown, q);
    else if (HTML_TYPES.has(type)) html = Math.max(html, q);
  }

  return markdown > 0 && markdown > html;
}

/** The response headers every markdown representation carries. */
export function markdownHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "text/markdown; charset=utf-8",
    // Without this, a cache that stored the markdown answer would serve it to
    // the next browser that asked for the same URL. The whole feature is one
    // URL with two representations, which is exactly what `Vary` is for.
    Vary: "Accept",
    ...extra,
  };
}
