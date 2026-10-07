/**
 * PostHog public status feed. status.posthog.com redirects to
 * www.posthogstatus.com, an incident.io page (verified 2026-10) that serves
 * no Statuspage-compatible JSON (`/api/v2/*.json` answer 404) but does serve
 * RSS at `/feed.rss`. Each item is one incident; its description starts with
 * `Status: <state>` and lists the affected components. Resolved items stay in
 * the feed, so they are skipped. Components that name a cloud region (`US`
 * or `EU`) scope the incident to that region, which is the `region` every
 * resource carries; everything else is provider-wide.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.posthogstatus.com/feed.rss",
  format: "rss",
  statusPageUrl: "https://www.posthogstatus.com",
};

function stateOf(text: string): StatusIncident["state"] | "resolved" {
  const m = /Status:\s*([A-Za-z ]+)/i.exec(text);
  const s = (m?.[1] ?? "").trim().toLowerCase();
  if (s.startsWith("resolved")) return "resolved";
  if (s.startsWith("monitoring")) return "monitoring";
  if (s.startsWith("identified") || s.startsWith("fixing")) return "identified";
  return "investigating";
}

export function regionsIn(text: string): string[] {
  const out = new Set<string>();
  if (/\bEU\b|Europe/.test(text)) out.add("eu");
  if (/\bUS\b/.test(text)) out.add("us");
  return Array.from(out);
}

export function parseStatusFeed(body: string): StatusIncident[] {
  if (!/<rss|<feed/i.test(body)) throw new Error("PostHog status feed: not an RSS document");
  const out: StatusIncident[] = [];
  for (const item of parseStatusFeedXml(body)) {
    const text = item.description ?? "";
    const state = stateOf(text);
    if (state === "resolved") continue;
    const regions = regionsIn(`${item.title} ${text}`);
    const components = /Affected components\s*([\s\S]*)$/i.exec(text)?.[1] ?? "";
    // "App (Web & Desktop) (Operational) Data Warehouse (Degraded performance)"
    const services = Array.from(
      components.matchAll(
        /\s*(.+?)\s*\((Operational|Degraded performance|Partial outage|Full outage|Under maintenance)\)/gi,
      ),
    )
      .map((m) => (m[1] ?? "").trim())
      .filter(Boolean)
      .slice(0, 10);
    const startedAt =
      item.publishedAt && !Number.isNaN(Date.parse(item.publishedAt))
        ? new Date(Date.parse(item.publishedAt)).toISOString()
        : new Date(0).toISOString();
    out.push({
      externalId: item.guid,
      title: item.title.slice(0, 300),
      state,
      impact: /degraded|delay/i.test(`${item.title} ${text}`) ? "minor" : "major",
      url: item.link ?? statusFeed.statusPageUrl ?? statusFeed.url,
      startedAt,
      lastUpdateText: text
        .replace(/Status:\s*[A-Za-z ]+/i, "")
        .slice(0, 500)
        .trim(),
      regions,
      services: Array.from(new Set(services)),
      ...(regions.length === 0 ? { providerWide: true } : {}),
    });
  }
  return out;
}
