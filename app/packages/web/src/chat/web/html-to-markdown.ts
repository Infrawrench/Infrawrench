/**
 * HTML → Markdown-ish plain text, for feeding a fetched page to the model.
 *
 * Hand-rolled rather than pulling in Turndown, which is what Claude Code uses.
 * Turndown needs a DOM (it bundles a shim), and the whole of what we want from
 * it here is "throw away the chrome, keep the prose, keep the links and code
 * fences" — the output is never rendered, only read by a model, so fidelity
 * beyond that buys nothing. This keeps the server bundle's dependency surface
 * where it is; the same instinct as the CLI's hand-rolled ANSI output.
 *
 * It is regex-based and therefore approximate. That is an accepted trade: the
 * failure mode is slightly ugly text, and the caller truncates and labels the
 * result as untrusted anyway. If a page ever needs real parsing, that is the
 * point to reach for a dependency.
 */

/** Elements whose *contents* are chrome or code we can't render, not prose. */
const DROPPED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "svg",
  "head",
  "iframe",
  "template",
  "form",
  "nav",
  "footer",
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  minus: "−",
  euro: "€",
  pound: "£",
  yen: "¥",
  sect: "§",
  para: "¶",
  dagger: "†",
  larr: "←",
  rarr: "→",
  harr: "↔",
  hArr: "⇔",
  ne: "≠",
  le: "≤",
  ge: "≥",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** The page's own title, from `<title>` or an `og:title` meta. */
export function extractTitle(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]) {
    const text = decodeEntities(title[1].replace(/\s+/g, " ")).trim();
    if (text) return text;
  }
  const og =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i.exec(html);
  const text = og?.[1] ? decodeEntities(og[1]).trim() : "";
  return text || null;
}

/**
 * Resolve `href` against the page URL so the model gets links it can actually
 * pass back to the fetch tool. A relative link in the output would otherwise be
 * unusable — and worse, guessable-wrong.
 */
function absolute(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function dropElement(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
}

export function htmlToMarkdown(html: string, baseUrl: string): string {
  let out = html;

  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DROPPED_ELEMENTS) out = dropElement(out, tag);
  // Unclosed <script>/<style> (or one closed by the document ending) would
  // otherwise leak their whole body as text.
  out = out.replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, " ");

  // Pre-formatted blocks are pulled out before whitespace collapsing, then put
  // back as fences at the end.
  const fences: string[] = [];
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, body: string) => {
    const code = decodeEntities(body.replace(/<[^>]+>/g, "")).replace(/\s+$/, "");
    fences.push(code);
    // NUL-delimited so the placeholder cannot collide with text the page
    // itself contains, and so the whitespace pass below leaves it intact.
    return `\n\n\u0000FENCE${fences.length - 1}\u0000\n\n`;
  });

  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, body: string) => {
    const code = decodeEntities(body.replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    return code ? `\`${code}\`` : "";
  });

  out = out.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_m, level: string, body: string) => {
      const text = body
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n\n";
    },
  );

  out = out.replace(
    /<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, href: string, body: string) => {
      const text = body
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return "";
      // A same-page anchor resolves to a perfectly valid URL pointing back at
      // the page we already have, so it has to be dropped before resolution
      // rather than by the protocol check below.
      if (href.trim().startsWith("#")) return text;
      const url = absolute(decodeEntities(href), baseUrl);
      // javascript:, mailto: and friends resolve to something the fetch tool
      // can't use; keep the words, drop the link.
      if (!url || !/^https?:/i.test(url)) return text;
      return `[${text}](${url})`;
    },
  );

  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, body: string) => {
    const text = body.replace(/<[^>]+>/g, "").trim();
    return text ? `**${text}**` : "";
  });
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, body: string) => {
    const text = body.replace(/<[^>]+>/g, "").trim();
    return text ? `*${text}*` : "";
  });

  // The opening tag already breaks the line; closing it too would put a blank
  // line between every pair of items.
  out = out.replace(/<li\b[^>]*>/gi, "\n- ");
  out = out.replace(/<\/li\s*>/gi, "");
  out = out.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n");
  out = out.replace(/<br\b[^>]*\/?>/gi, "\n");
  out = out.replace(/<\/(td|th)\s*>/gi, " | ");
  out = out.replace(
    /<\/(p|div|section|article|blockquote|tr|ul|ol|dl|dd|dt|table|main)\s*>/gi,
    "\n\n",
  );

  out = out.replace(/<[^>]+>/g, " ");
  out = decodeEntities(out);

  // Collapse the whitespace the tag soup left behind, without touching the
  // line structure the block elements just established.
  out = out
    .split("\n")
    .map((line) =>
      line
        .replace(/[^\S\n]+/g, " ")
        .replace(/ \|\s*$/, "")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  out = out.replace(/\u0000FENCE(\d+)\u0000/g, (_m, index: string) => {
    const code = fences[Number(index)] ?? "";
    return code ? `\`\`\`\n${code}\n\`\`\`` : "";
  });

  return out.replace(/\n{3,}/g, "\n\n").trim();
}
