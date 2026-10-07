/**
 * Checkly public status feed (https://is.checkly.online, Checkly's own status
 * page product; status.checklyhq.com redirects there). It publishes no JSON,
 * only RSS at `/feed.rss` (verified 2026-10): one item per update, newest
 * first, all updates of an incident sharing the incident URL as `guid`. An
 * update's description starts `Status: <state>` and lists
 * "Affected components" as `<li>` items; maintenance announcements are titled
 * "Maintenance scheduled: …". The newest item per incident decides its state.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://is.checkly.online/feed.rss",
  format: "rss",
  statusPageUrl: "https://is.checkly.online",
};

const CHECK_TYPES = ["check", "check-group", "private-location"];

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  const inner = (m?.[1] ?? "").trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return (cdata?.[1] ?? inner).trim();
}

function stateOf(status: string): StatusIncidentState | "resolved" {
  const s = status.toLowerCase();
  if (s.startsWith("resolved") || s.startsWith("completed")) return "resolved";
  if (s.startsWith("identified")) return "identified";
  if (s.startsWith("monitoring")) return "monitoring";
  return "investigating";
}

export function parseStatusFeed(body: string): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body)) throw new Error("Checkly status feed: not an RSS document");
  const blocks = body.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const seen = new Set<string>();
  const out: StatusIncident[] = [];
  for (const block of blocks) {
    const guid = tag(block, "guid") || tag(block, "link");
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    const title = stripStatusHtml(tag(block, "title"));
    const rawDescription = tag(block, "description");
    const description = stripStatusHtml(rawDescription);
    const isMaintenance = /\/maintenance\//.test(guid) || /^maintenance/i.test(title);
    // Announcements of future windows are not outages.
    if (/^maintenance scheduled/i.test(title)) continue;
    const statusMatch = /Status:\s*([A-Za-z ]+?)(?:<br|$|\.|\n)/.exec(rawDescription);
    const state = stateOf(
      statusMatch?.[1] ?? (/^maintenance (completed|ended)/i.test(title) ? "completed" : ""),
    );
    if (state === "resolved") continue;
    const components = [...rawDescription.matchAll(/<li>([\s\S]*?)<\/li>/gi)]
      .map((m) => stripStatusHtml(m[1] ?? ""))
      .filter(Boolean);
    const published = Date.parse(tag(block, "pubDate"));
    const startedAt = Number.isFinite(published)
      ? new Date(published).toISOString()
      : new Date(0).toISOString();
    const affectsChecks =
      components.length === 0 ||
      components.some((c) => /check|monitor|runtime|alert|location|api|app/i.test(c));
    out.push({
      externalId: guid,
      title,
      state,
      impact: isMaintenance
        ? "maintenance"
        : /outage|down|unavailable/i.test(title)
          ? "major"
          : "minor",
      url: tag(block, "link") || guid,
      startedAt,
      lastUpdateAt: startedAt,
      ...(description ? { lastUpdateText: description.slice(0, 500) } : {}),
      regions: [],
      services: components,
      ...(affectsChecks ? { resourceTypes: CHECK_TYPES } : {}),
      ...(components.length === 0 ? { providerWide: true } : {}),
    });
  }
  return out;
}
