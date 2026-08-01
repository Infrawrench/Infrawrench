/**
 * Hetzner public status feed (Atom, https://status.hetzner.com/en.atom —
 * verified 2026-08).
 *
 * The Atom feed mixes current and past incidents with no machine-readable
 * lifecycle state, so an entry counts as an active incident only when it was
 * published within the last 7 days and its title/description do not read as
 * resolved (English or German). Location codes (fsn1, nbg1, hel1, ash, hil,
 * sin — exactly the lowercase `location` slugs Hetzner resources carry)
 * appear only in free text, so title+description are scanned for them; an
 * entry naming no location is treated as provider-wide.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatusFeedXml, stripStatusHtml } from "@infrawrench/plugin-base";

const STATUS_PAGE = "https://status.hetzner.com";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.hetzner.com/en.atom",
  format: "atom",
  statusPageUrl: STATUS_PAGE,
};

/** Entries older than this are history, not active incidents. */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** English + German "it's over" markers. */
const RESOLVED_WORDS = /resolved|completed|abgeschlossen|beendet/i;

/**
 * Unambiguous Hetzner location slugs (fsn1, nbg1, hel1) match freely.
 * Ambiguous three-letter codes (ash, hil, sin):
 *   - with location-like context ("Location: Ash", "DC ash") — case-insensitive
 *   - standalone uppercase only ("ASH", "HIL", "SIN") so ordinary English
 *     words like "ash" / "hil" / "sin" don't force a region match
 */
const UNAMBIGUOUS_LOCATION = /\b(fsn1|nbg1|hel1)\b/gi;
/** Contextual ambiguous codes — case-insensitive labels/prefixes. */
const AMBIGUOUS_CONTEXTUAL =
  /(?:\b(?:dc|location|standort|datacenter|data\s*center)\b[\s:#-]*)\b(ash|hil|sin)\b|\((ash|hil|sin)\)/gi;
/** Standalone ambiguous codes — uppercase only. */
const AMBIGUOUS_STANDALONE = /\b(ASH|HIL|SIN)\b/g;

/** Exported for unit tests. */
export function extractLocations(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(UNAMBIGUOUS_LOCATION)) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(AMBIGUOUS_CONTEXTUAL)) {
    const code = m[1] ?? m[2];
    if (code) found.add(code.toLowerCase());
  }
  for (const m of text.matchAll(AMBIGUOUS_STANDALONE)) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  return Array.from(found);
}

export function parseStatusFeed(body: string): StatusIncident[] {
  if (!/<feed[\s>]/i.test(body)) {
    throw new Error("Hetzner status feed: not an Atom document");
  }
  const items = parseStatusFeedXml(body);
  const now = Date.now();
  const out: StatusIncident[] = [];
  for (const item of items) {
    // Prefer the newer of publishedAt and any Atom `updated` the extractor
    // folded into publishedAt; parseStatusFeedXml already falls back to
    // <updated> when <published> is absent.
    const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    if (Number.isNaN(published) || now - published > ACTIVE_WINDOW_MS) continue;
    const text = `${item.title} ${item.description ?? ""}`;
    if (RESOLVED_WORDS.test(text)) continue;
    const regions = extractLocations(text);
    const description = item.description
      ? stripStatusHtml(item.description).slice(0, 500)
      : undefined;
    out.push({
      externalId: item.guid,
      title: item.title,
      state: "investigating",
      impact: "major",
      url: item.link ?? STATUS_PAGE,
      startedAt: new Date(published).toISOString(),
      ...(description ? { lastUpdateText: description } : {}),
      regions,
      services: [],
      ...(regions.length === 0 ? { providerWide: true } : {}),
    });
  }
  return out;
}
