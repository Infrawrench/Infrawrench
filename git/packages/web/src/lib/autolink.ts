/**
 * Plain text with its web addresses found: what a bio is shown as. The text
 * stays text (the caller renders each part as a React child, never as HTML)
 * and an address becomes a link only when `webUrl` reads it as `http:` or
 * `https:`, so nothing a person types can be a `javascript:` link or markup.
 */
import { webUrl } from "./safe-url";

export interface TextPart {
  readonly text: string;
  /** Where the part links to, normalised; null for ordinary text. */
  readonly href: string | null;
}

const ADDRESS = /https?:\/\/[^\s<>"'`]+/gi;
/** What ends a sentence rather than an address. */
const TRAILING = /[.,;:!?'"]+$/;

/** An address as it was meant: without the full stop or the bracket of the sentence around it. */
function trimAddress(raw: string): string {
  let address = raw.replace(TRAILING, "");
  // A closing bracket belongs to the address only when the address opened it.
  while (address.endsWith(")") && !address.includes("(")) {
    address = address.slice(0, -1).replace(TRAILING, "");
  }
  return address;
}

export function autolink(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  const push = (value: string, href: string | null) => {
    if (value === "") return;
    const previous = parts[parts.length - 1];
    // Neighbouring text is one part, so an address that was refused leaves no seam.
    if (href === null && previous !== undefined && previous.href === null) {
      parts[parts.length - 1] = { text: previous.text + value, href: null };
    } else parts.push({ text: value, href });
  };
  for (const match of text.matchAll(ADDRESS)) {
    const address = trimAddress(match[0]);
    const href = webUrl(address);
    push(text.slice(last, match.index), null);
    push(address, href);
    last = match.index + address.length;
  }
  push(text.slice(last), null);
  return parts;
}
