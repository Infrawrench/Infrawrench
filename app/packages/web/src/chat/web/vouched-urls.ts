/**
 * Which URLs `web_fetch` may read without asking.
 *
 * A fetch is a GET, but a GET is still an outbound request whose URL the model
 * chooses, and a URL can carry data in its path or query string. A model that
 * has just read a database password (or a log line telling it to go and read
 * one) can put that value in a URL to a host the attacker runs, and the request
 * itself is the leak, whatever comes back. So the tool runs unprompted only for
 * a URL that nobody downstream of the conversation could have constructed:
 *
 *   - one the user typed into the conversation, verbatim; or
 *   - one a `web_search` returned as a source, which the search index chose.
 *
 * Anything else, including links followed out of a fetched page, goes through
 * the approval card, where the user sees the exact URL before it is requested.
 */
import type { ChatContentBlock } from "@infrawrench/ui";

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
/** Sentence punctuation that commonly trails a URL pasted into prose. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>*_]+$/;

/** Canonical form for comparison: parsed, fragment dropped. Null if unparseable. */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function urlsInText(text: string, into: Set<string>): void {
  for (const match of text.matchAll(URL_IN_TEXT)) {
    // Try both the raw match and the match minus trailing punctuation, so
    // "see https://x.dev/a." vouches for https://x.dev/a without guessing which
    // one the user meant.
    for (const candidate of [match[0], match[0].replace(TRAILING_PUNCTUATION, "")]) {
      const normalized = normalizeUrl(candidate);
      if (normalized) into.add(normalized);
    }
  }
}

/**
 * Source URLs from a stored `web_search` result. Only the final `Sources:`
 * block counts: it is appended by `runSearch` after the search sub-model's
 * summary, so a summary that imitates the format (it is model output over
 * attacker-written pages, and it sees the query) cannot add to the list.
 */
function searchSources(text: string, into: Set<string>): void {
  const marker = "\nSources:\n";
  const at = text.lastIndexOf(marker);
  if (at < 0) return;
  for (const line of text.slice(at + marker.length).split("\n")) {
    if (!/^\[\d+\] /.test(line)) break;
    // `[n] title — url (age)`: the URL is the first token after the last
    // separator (a URL has no spaces, a title may contain the separator).
    const sep = line.lastIndexOf(" | ");
    if (sep < 0) continue;
    const url = line.slice(sep + 3).split(" ")[0];
    const normalized = url ? normalizeUrl(url) : null;
    if (normalized) into.add(normalized);
  }
}

/** Every URL the conversation vouches for, normalized. */
export function vouchedUrls(
  messages: ReadonlyArray<{ role: string; content: ChatContentBlock[] }>,
): Set<string> {
  const searchToolUseIds = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use" && b.name === "web_search") searchToolUseIds.add(b.id);
    }
  }
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.type === "text") urlsInText(b.text, out);
      else if (b.type === "tool_result" && searchToolUseIds.has(b.tool_use_id)) {
        const text =
          typeof b.content === "string" ? b.content : b.content.map((c) => c.text).join("\n");
        searchSources(text, out);
      }
    }
  }
  return out;
}

/** True when fetching `url` needs the user's approval first. */
export function fetchNeedsApproval(
  url: string,
  messages: ReadonlyArray<{ role: string; content: ChatContentBlock[] }>,
): boolean {
  const normalized = normalizeUrl(url);
  if (!normalized) return true;
  return !vouchedUrls(messages).has(normalized);
}
