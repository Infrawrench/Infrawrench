import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";

/**
 * Backblaze's status page (status.backblaze.com) is a FireHydrant page. Its
 * only machine-readable incident source is `/data/rss.xml` (the page's own
 * bundle loads it; `/data/payload.json` carries just the four region
 * components). Verified 2026-10-06.
 *
 * The feed is a short history with no lifecycle state per item, so activity is
 * inferred:
 * - "Scheduled Maintenance: …" items carry "Scheduled maintenance window:
 *   <start> - <end>" in the body and are active only inside that window.
 * - Anything else is an incident; it counts as active for 24 hours after its
 *   last publication unless its body says it is resolved.
 *
 * The body lists impacted components ("EU Central Region: Degraded …"), which
 * map onto the coarse region the plugin stores (`us-west`, `us-east`,
 * `eu-central`, `ca-east`).
 */

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.backblaze.com/data/rss.xml",
  format: "rss",
  statusPageUrl: "https://status.backblaze.com",
};

const REGION_COMPONENTS: Array<[RegExp, string]> = [
  [/US West Region/i, "us-west"],
  [/US East Region/i, "us-east"],
  [/EU Central Region/i, "eu-central"],
  [/CA East Region/i, "ca-east"],
];

const INCIDENT_ACTIVE_MS = 24 * 60 * 60 * 1000;

function regionsIn(text: string): string[] {
  return REGION_COMPONENTS.filter(([re]) => re.test(text)).map(([, id]) => id);
}

export function parseStatusFeed(body: string, now = Date.now()): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) {
    throw new Error("Backblaze status feed: not an RSS document");
  }
  const out: StatusIncident[] = [];
  for (const item of parseStatusFeedXml(body)) {
    const text = `${item.title} ${item.description ?? ""}`;
    const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    const maintenance = /^scheduled maintenance/i.test(item.title);
    let startedAt = Number.isNaN(published) ? now : published;
    if (maintenance) {
      const window =
        /maintenance window:\s*(.+?)\s+-\s+(\w{3}, \d{1,2} \w{3} \d{4} [\d:]+ [+-]\d{4})/i.exec(
          item.description ?? "",
        );
      if (!window) continue;
      const start = Date.parse(window[1]!);
      const end = Date.parse(window[2]!);
      if (Number.isNaN(start) || Number.isNaN(end) || now < start || now > end) continue;
      startedAt = start;
    } else {
      if (Number.isNaN(published) || now - published > INCIDENT_ACTIVE_MS) continue;
      if (/\bresolved\b/i.test(item.description ?? "")) continue;
    }
    const regions = regionsIn(text);
    out.push({
      externalId: item.guid,
      title: item.title.replace(/^scheduled maintenance:\s*/i, ""),
      state: "investigating",
      impact: maintenance
        ? "maintenance"
        : /critical|unavailable|outage/i.test(text)
          ? "major"
          : "minor",
      url: item.link ?? "https://status.backblaze.com",
      startedAt: new Date(startedAt).toISOString(),
      ...(item.description ? { lastUpdateText: item.description.slice(0, 500) } : {}),
      regions,
      services: /B2|Storage Pods|bucket/i.test(text) ? ["B2 Cloud Storage"] : [],
      ...(regions.length === 0 ? { providerWide: true } : {}),
    });
  }
  return out;
}
