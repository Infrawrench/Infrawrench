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
 * Comparative, and deliberately so. A browser sends
 * `text/html,application/xhtml+xml,application/xml;q=0.9,*​/*;q=0.8` — the
 * wildcard matches markdown, so "does it accept markdown" is true for every
 * browser alive and would serve plain text to the whole web. The question that
 * gives the right answer is "does it accept markdown *more* than HTML", and a
 * wildcard is not a preference for either.
 *
 * On equal quality, position decides, because that is how the clients that
 * matter here actually express a preference. Claude Code's fetch sends
 * `Accept: text/markdown, text/html, *​/*` — markdown named first, no weights
 * anywhere. RFC 9110 §12.5.1 makes `q` the normative mechanism and leaves ties
 * to the server, so ranking HTML first was conformant; it also meant the one
 * document written for agents was unreachable by the fetch an agent actually
 * makes, which is the opposite of the point. Where the caller expresses no
 * order — a tie it never created — nothing changes, because a browser does not
 * name markdown at all and loses on `markdown === 0`.
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
  // Position of the entry that set the score above, for the tie-break. A type
  // named twice at the same weight is pinned to its first mention, so
  // `text/html, ..., text/html` cannot lose a tie to its own repetition.
  let markdownAt = Number.POSITIVE_INFINITY;
  let htmlAt = Number.POSITIVE_INFINITY;
  for (const [index, { type, q }] of entries.entries()) {
    if (q === 0) continue;
    if (MARKDOWN_TYPES.has(type)) {
      if (q > markdown) [markdown, markdownAt] = [q, index];
      else if (q === markdown) markdownAt = Math.min(markdownAt, index);
    } else if (HTML_TYPES.has(type)) {
      if (q > html) [html, htmlAt] = [q, index];
      else if (q === html) htmlAt = Math.min(htmlAt, index);
    }
  }

  if (markdown === 0) return false;
  if (markdown !== html) return markdown > html;
  return markdownAt < htmlAt;
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
