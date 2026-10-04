/**
 * The two fonts every PDF here is set in: Helvetica and Helvetica-Bold, two
 * of the fourteen "standard" Type 1 fonts every conforming PDF reader ships.
 * Referencing a standard font costs no embedded font file at all, which is
 * most of why a dashboard export is tens of kilobytes rather than megabytes.
 *
 * The price is the encoding: a standard font is addressed through
 * WinAnsiEncoding, a single-byte code page (Latin-1 plus the typographic
 * extras in 0x80–0x9F). {@link toWinAnsi} maps what it can and substitutes
 * `?` for the rest, so a resource name in a script WinAnsi cannot spell still
 * renders as something rather than breaking the document. That trade is
 * written down in KNOWLEDGE.md ("Dashboard and report PDFs").
 *
 * Widths are the Adobe Font Metrics advance widths (thousandths of an em) for
 * the printable ASCII range, which is what the layout measures to wrap and
 * truncate. Characters outside it use a per-font average: close enough for
 * the occasional accented letter, and only ever used for layout, never for
 * what the reader draws.
 */

export type PdfFontName = "regular" | "bold";

/** PDF base font names, as written into the font dictionaries. */
export const PDF_BASE_FONTS: Record<PdfFontName, string> = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
};

// Advance widths for char codes 32..126, in order.
// prettier-ignore
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// prettier-ignore
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Widths for the WinAnsi extras the layout is most likely to meet. */
const EXTRA_WIDTHS: Record<number, number> = {
  0x80: 556, // €
  0x85: 1000, // …
  0x91: 222, // ‘
  0x92: 222, // ’
  0x93: 333, // “
  0x94: 333, // ”
  0x95: 350, // •
  0x96: 556, // –
  0x97: 1000, // —
  0xa0: 278, // nbsp
  0xa3: 556, // £
  0xa5: 556, // ¥
  0xb7: 278, // ·
  0xd7: 584, // ×
};

/** Unicode code points that WinAnsi places in 0x80–0x9F. */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/** Common symbols with no WinAnsi slot, spelled in ones that have one. */
const FALLBACKS: Record<string, string> = {
  "→": "->",
  "←": "<-",
  "↑": "^",
  "↓": "v",
  "≈": "~",
  "≤": "<=",
  "≥": ">=",
  "−": "-",
  "✓": "v",
  "✗": "x",
  " ": " ",
  " ": " ",
};

/**
 * Encode a string as WinAnsi bytes. Unmappable characters become `?`, after
 * a small table of readable substitutions (an arrow becomes `->`).
 */
export function toWinAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const fallback = FALLBACKS[ch];
    if (fallback !== undefined) {
      for (const f of fallback) out.push(f.charCodeAt(0));
      continue;
    }
    const cp = ch.codePointAt(0) ?? 63;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      out.push(0x20);
    } else if (cp >= 0x20 && cp <= 0x7e) {
      out.push(cp);
    } else if (cp >= 0xa0 && cp <= 0xff) {
      out.push(cp);
    } else if (WIN_ANSI_HIGH[cp] !== undefined) {
      out.push(WIN_ANSI_HIGH[cp]);
    } else {
      out.push(0x3f);
    }
  }
  return out;
}

/** Advance width of one WinAnsi byte, in thousandths of an em. */
function byteWidth(code: number, font: PdfFontName): number {
  const table = font === "bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  if (code >= 32 && code <= 126) return table[code - 32] ?? 556;
  return EXTRA_WIDTHS[code] ?? (font === "bold" ? 611 : 556);
}

/** Width of `text` set at `size` points, in points. */
export function textWidth(text: string, size: number, font: PdfFontName = "regular"): number {
  let total = 0;
  for (const code of toWinAnsi(text)) total += byteWidth(code, font);
  return (total * size) / 1000;
}

/**
 * `text` shortened with an ellipsis until it fits `maxWidth` points. Returns
 * the input unchanged when it already fits.
 */
export function truncateText(
  text: string,
  maxWidth: number,
  size: number,
  font: PdfFontName = "regular",
): string {
  if (textWidth(text, size, font) <= maxWidth) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${chars.slice(0, mid).join("")}…`, size, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "…" : `${chars.slice(0, lo).join("").trimEnd()}…`;
}

/**
 * Greedy word wrap to `maxWidth` points. A single word longer than the line
 * is truncated rather than split mid-word: these are labels and sentences,
 * not prose that needs hyphenation.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  font: PdfFontName = "regular",
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, font) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = truncateText(word, maxWidth, size, font);
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}
