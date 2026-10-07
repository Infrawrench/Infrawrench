/**
 * Okta public status feed. status.okta.com is a Salesforce site whose
 * /api/v2/* paths redirect to a login page (verified 2026-10), so the only
 * machine-readable source is the Atom feed Okta publishes through FeedBurner
 * (https://feeds.feedburner.com/OktaTrustRSS, linked from the status page).
 *
 * Entries are titled "<Resolved |>Service Disruption|Degradation|Feature
 * Disruption|...", carry the incident text in <content>, and name the
 * affected cells ("US Cell 1", "EMEA Cell 9") in prose. An org's cell is not
 * exposed by the Management API, so every incident is provider-wide.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
} from "@infrawrench/plugin-base";
import { parseStatusFeedXml, stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://feeds.feedburner.com/OktaTrustRSS",
  format: "atom",
  statusPageUrl: "https://status.okta.com",
};

function impactOf(title: string): StatusIncidentImpact {
  if (/maintenance/i.test(title)) return "maintenance";
  if (/service disruption/i.test(title)) return "major";
  return "minor";
}

export function parseStatusFeed(body: string): StatusIncident[] {
  if (!/<feed|<rss/i.test(body)) throw new Error("okta status feed: not an Atom/RSS document");
  const contents = body.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const items = parseStatusFeedXml(body);
  const out: StatusIncident[] = [];
  items.forEach((item, index) => {
    if (/^resolved\b/i.test(item.title) || /^completed?\b/i.test(item.title)) return;
    const block = contents[index] ?? "";
    const content =
      block.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ?? item.description ?? "";
    const text = stripStatusHtml(content);
    out.push({
      externalId: item.guid,
      title: item.title,
      state: "investigating",
      impact: impactOf(item.title),
      ...(item.link ? { url: item.link } : {}),
      startedAt: item.publishedAt ?? new Date(0).toISOString(),
      ...(item.publishedAt ? { lastUpdateAt: item.publishedAt } : {}),
      ...(text ? { lastUpdateText: text } : {}),
      regions: [],
      services: [],
      providerWide: true,
    });
  });
  return out;
}
