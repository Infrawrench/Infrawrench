/**
 * Redis service health feed (https://status.redis.io, a FireHydrant page;
 * verified 2026-10). The page publishes an RSS history at `/data/rss.xml`
 * with one item per incident *update* ("New incident: …", "Update for
 * incident …", "Note on incident …"), all linking to
 * `/incidents/<uuid>`. Items are grouped by that link; the newest item for
 * an incident carries its current milestone in the description ("Milestone
 * is now 'resolved'"). Components are not structured in the feed, so every
 * incident is provider-wide: the page covers Redis Cloud's console, API and
 * DNS, which everything this plugin shows depends on.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";

const STATUS_PAGE = "https://status.redis.io";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.redis.io/data/rss.xml",
  format: "rss",
  statusPageUrl: STATUS_PAGE,
};

/** Incidents whose last update is older than this are dropped as history. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function milestoneState(text: string | undefined): StatusIncidentState | undefined {
  const m = /Milestone is now '([a-z_ -]+)'/i.exec(text ?? "");
  if (!m) return undefined;
  switch (m[1]!.toLowerCase()) {
    case "resolved":
    case "postmortem_started":
    case "postmortem_completed":
    case "postmortem":
      return "resolved";
    case "mitigated":
    case "monitoring":
      return "monitoring";
    case "identified":
      return "identified";
    default:
      return "investigating";
  }
}

function incidentTitle(itemTitle: string): string {
  const m = /incident\s*[:]?\s*"(.+)"\s*$/i.exec(itemTitle);
  return m?.[1] ?? itemTitle;
}

export function parseStatusFeed(body: string, now: number = Date.now()): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) {
    throw new Error("Redis status feed: not an RSS document");
  }
  const byIncident = new Map<
    string,
    {
      title: string;
      url: string;
      started: number;
      last: number;
      lastText?: string;
      state?: StatusIncidentState;
    }
  >();
  for (const item of parseStatusFeedXml(body)) {
    const url = item.link ?? STATUS_PAGE;
    const at = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    if (Number.isNaN(at)) continue;
    const entry = byIncident.get(url);
    const state = milestoneState(item.description);
    if (!entry) {
      byIncident.set(url, {
        title: incidentTitle(item.title),
        url,
        started: at,
        last: at,
        ...(item.description ? { lastText: item.description.slice(0, 500) } : {}),
        ...(state ? { state } : {}),
      });
      continue;
    }
    entry.started = Math.min(entry.started, at);
    if (at > entry.last) {
      entry.last = at;
      if (item.description) entry.lastText = item.description.slice(0, 500);
      if (state) entry.state = state;
    } else if (!entry.state && state) {
      entry.state = state;
    }
  }
  const out: StatusIncident[] = [];
  for (const [url, e] of byIncident) {
    if (now - e.last > MAX_AGE_MS) continue;
    const state = e.state ?? "investigating";
    out.push({
      externalId: url,
      title: e.title,
      state,
      impact: "major",
      url,
      startedAt: new Date(e.started).toISOString(),
      lastUpdateAt: new Date(e.last).toISOString(),
      ...(state === "resolved" ? { resolvedAt: new Date(e.last).toISOString() } : {}),
      ...(e.lastText ? { lastUpdateText: e.lastText } : {}),
      regions: [],
      services: [],
      providerWide: true,
    });
  }
  return out;
}
