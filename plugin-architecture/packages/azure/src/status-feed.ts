/**
 * Azure public status feed (RSS,
 * https://azure.status.microsoft/en-us/status/feed/ — verified 2026-08).
 *
 * The channel is empty (zero items) when Azure is healthy; items exist only
 * during active incidents, so every item maps to an active provider-wide
 * incident. Affected regions appear only in free prose within the item
 * description — there is no structured region field — so no region mapping
 * is attempted.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";

const STATUS_PAGE = "https://azure.status.microsoft/en-us/status";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://azure.status.microsoft/en-us/status/feed/",
  format: "rss",
  statusPageUrl: STATUS_PAGE,
};

export function parseStatusFeed(body: string): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) {
    throw new Error("Azure status feed: not an RSS document");
  }
  // Zero items is the healthy steady state, not a parse failure.
  return parseStatusFeedXml(body).map((item) => {
    const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    return {
      externalId: item.guid,
      title: item.title,
      state: "investigating" as const,
      impact: "major" as const,
      url: item.link ?? STATUS_PAGE,
      startedAt: Number.isNaN(published)
        ? new Date().toISOString()
        : new Date(published).toISOString(),
      ...(item.description ? { lastUpdateText: item.description } : {}),
      regions: [],
      services: [],
      providerWide: true,
    };
  });
}
