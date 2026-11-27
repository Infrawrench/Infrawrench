/**
 * Unicode's bidirectional embeddings, overrides and isolates (U+202A to
 * U+202E, U+2066 to U+2069). They are invisible and reorder the text after
 * them, so a line of code, a file name or a commit title can display
 * differently from what it is: `evil‮txt.exe` reads as `evilexe.txt`.
 * Wherever the site shows such text it writes them out as `<U+202E>`
 * instead. The marks U+200E, U+200F and U+061C are left alone: they only
 * place neutral characters in right-to-left text and cannot reorder words.
 */
const BIDI_CONTROL = /[‪-‮⁦-⁩]/;
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

export const hasBidiControls = (text: string): boolean => BIDI_CONTROL.test(text);

/** How a control is written out: `<U+202E>`. */
export const bidiName = (control: string): string =>
  `<U+${control.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`;

/** `text` with every bidirectional control written out, for names and titles. */
export const showBidi = (text: string): string =>
  BIDI_CONTROL.test(text) ? text.replace(BIDI_CONTROLS, bidiName) : text;

export interface BidiPart {
  readonly text: string;
  /** True for one control character, which the caller draws as a visible mark. */
  readonly control: boolean;
}

/** `text` as runs of ordinary text and single controls, for code that marks them. */
export function splitBidi(text: string): BidiPart[] {
  if (!BIDI_CONTROL.test(text)) return [{ text, control: false }];
  const parts: BidiPart[] = [];
  let last = 0;
  for (const match of text.matchAll(BIDI_CONTROLS)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), control: false });
    parts.push({ text: match[0], control: true });
    last = match.index + 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last), control: false });
  return parts;
}
