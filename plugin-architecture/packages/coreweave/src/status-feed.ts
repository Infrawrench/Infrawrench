/**
 * CoreWeave public status feed: the status.io RSS feed linked from
 * https://status.coreweave.com (verified 2026-10).
 *
 * Unlike an "active incidents only" feed, this one keeps history: every item
 * is an incident or a maintenance window, and its description is the full
 * update log, oldest first, each entry starting with a bold state word
 * ("Investigating", "Identified", "Monitoring", "Resolved"; or for
 * maintenance "Scheduled", "Active", "Completed"). Only items whose latest
 * state is still open are reported. Scheduled maintenance that has not
 * started is skipped: it is not an outage yet.
 *
 * Availability Zones appear in titles ("… - US-CENTRAL-09A"), so they map to
 * regions. Nothing in the feed names a product, so incidents are
 * provider-wide.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";

const STATUS_PAGE = "https://status.coreweave.com";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.coreweave.com/pages/5e126e998f2f032e1f8f0f4b/rss",
  format: "rss",
  statusPageUrl: STATUS_PAGE,
};

const STATES = [
  "Investigating",
  "Identified",
  "Monitoring",
  "Resolved",
  "Scheduled",
  "Active",
  "In Progress",
  "Completed",
  "Update",
] as const;

const CLOSED = new Set(["Resolved", "Completed"]);
const NOT_STARTED = new Set(["Scheduled"]);

const STATE_RE = new RegExp(`\\b(${STATES.join("|")})\\s+-\\s`, "g");
const ZONE_RE = /\b(?:[A-Z]{2}-[A-Z]+-\d{2}[A-Z]|RNO2A)\b/g;

/** The last state word in an update log, or undefined when none is found. */
export function latestState(description: string): string | undefined {
  let last: string | undefined;
  for (const m of description.matchAll(STATE_RE)) last = m[1];
  return last;
}

function stateOf(latest: string | undefined): StatusIncident["state"] {
  switch (latest) {
    case "Identified":
      return "identified";
    case "Monitoring":
      return "monitoring";
    case "Resolved":
    case "Completed":
      return "resolved";
    default:
      return "investigating";
  }
}

export function parseStatusFeed(body: string): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) {
    throw new Error("CoreWeave status feed: not an RSS document");
  }
  const out: StatusIncident[] = [];
  for (const item of parseStatusFeedXml(body)) {
    const description = item.description ?? "";
    const latest = latestState(description);
    if (latest && (CLOSED.has(latest) || NOT_STARTED.has(latest))) continue;
    const maintenance = /maintenance/i.test(item.title) || /\/maintenance\//.test(item.link ?? "");
    const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    const regions = [...new Set(item.title.match(ZONE_RE) ?? [])];
    out.push({
      externalId: item.guid,
      title: item.title,
      state: stateOf(latest),
      impact: maintenance ? "maintenance" : "major",
      url: item.link ?? STATUS_PAGE,
      startedAt: Number.isNaN(published)
        ? new Date(0).toISOString()
        : new Date(published).toISOString(),
      ...(description ? { lastUpdateText: description.slice(-500) } : {}),
      regions,
      services: [],
      providerWide: true,
    });
  }
  return out;
}
