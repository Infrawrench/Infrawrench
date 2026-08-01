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
import { parseStatusFeedXml } from "@infrawrench/plugin-base";

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

/** Hetzner location slugs, as carried in resource `location` fields. */
const LOCATION_CODES = /\b(fsn1|nbg1|hel1|ash|hil|sin)\b/gi;

export function parseStatusFeed(body: string): StatusIncident[] {
  if (!/<feed[\s>]/i.test(body)) {
    throw new Error("Hetzner status feed: not an Atom document");
  }
  const items = parseStatusFeedXml(body);
  const now = Date.now();
  const out: StatusIncident[] = [];
  for (const item of items) {
    const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    if (Number.isNaN(published) || now - published > ACTIVE_WINDOW_MS) continue;
    const text = `${item.title} ${item.description ?? ""}`;
    if (RESOLVED_WORDS.test(text)) continue;
    const regions = Array.from(
      new Set(
        Array.from(text.matchAll(LOCATION_CODES))
          .map((m) => m[1]?.toLowerCase())
          .filter((r): r is string => typeof r === "string"),
      ),
    );
    out.push({
      externalId: item.guid,
      title: item.title,
      state: "investigating",
      impact: "major",
      url: item.link ?? STATUS_PAGE,
      startedAt: new Date(published).toISOString(),
      ...(item.description ? { lastUpdateText: item.description } : {}),
      regions,
      services: [],
      ...(regions.length === 0 ? { providerWide: true } : {}),
    });
  }
  return out;
}
