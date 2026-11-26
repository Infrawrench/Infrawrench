/**
 * `Co-authored-by:` trailers, as GitHub reads them: lines of the message's
 * last paragraph, `Co-authored-by: Name <email>` in any case. The forge's
 * Worker and the UI's mock both read them here.
 */

export interface CoAuthorTrailer {
  readonly name: string;
  readonly email: string;
}

/** More than this many is a message listing a team, not a commit's authors. */
export const MAX_CO_AUTHORS = 20;

const TRAILER = /^co-authored-by:\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/i;

/**
 * The co-authors a commit message names, in order, each email once, and
 * never the commit's own author (`authorEmail`).
 */
export function coAuthorsOf(message: string, authorEmail: string): CoAuthorTrailer[] {
  const paragraphs = message.replace(/\s+$/, "").split(/\n[ \t]*\n/);
  // The first paragraph is the summary: a one-line message has no trailers.
  if (paragraphs.length < 2) return [];
  const lines = paragraphs[paragraphs.length - 1]!.split("\n");
  const seen = new Set([authorEmail.toLowerCase()]);
  const out: CoAuthorTrailer[] = [];
  for (const line of lines) {
    const match = TRAILER.exec(line.trim());
    if (!match) continue;
    const email = match[2]!;
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push({ name: match[1]! || email, email });
    if (out.length >= MAX_CO_AUTHORS) break;
  }
  return out;
}
