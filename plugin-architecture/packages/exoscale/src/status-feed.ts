/**
 * Exoscale's status page (https://exoscalestatus.com) publishes its incident
 * history as RSS at `/history.rss` (checked 2026-10-06; it has no Statuspage
 * API). Titles are "[CH-GVA-2] …" or "[Compute API] …"; each description
 * starts with "<strong>Scheduled maintenance</strong> - CH-GVA-2, …" (or
 * the impact) and its latest update's state in `<strong>` after the
 * timestamp ("Resolved", "Completed", "Started", "Scheduled",
 * "Investigating", "Monitoring"). Maintenance items carry
 * `<category domain="event:start|end">`.
 */

import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://exoscalestatus.com/history.rss",
  format: "rss",
  statusPageUrl: "https://exoscalestatus.com",
};

const ZONE = /\b([A-Z]{2})-([A-Z]{2,3})-(\d)\b/g;
const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
const tag = (item: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item)?.[1]?.trim() ?? "";

export function zonesIn(text: string): string[] {
  return [...new Set([...text.matchAll(ZONE)].map((m) => `${m[1]}-${m[2]}-${m[3]}`.toLowerCase()))];
}

const PRODUCTS: Array<[RegExp, string, string[]]> = [
  [/sks|kubernetes/i, "SKS", ["sks-cluster", "sks-nodepool"]],
  [/dbaas|database/i, "DBaaS", ["dbaas", "dbaas-user", "dbaas-database"]],
  [/\bsos\b|object storage/i, "Object Storage", ["bucket"]],
  [/block storage/i, "Block Storage", ["block-storage", "block-storage-snapshot"]],
  [/\bnlb\b|load balanc/i, "Network Load Balancer", ["nlb"]],
  [/\bdns\b/i, "DNS", ["dns-domain", "dns-record"]],
];

export function parseStatusFeed(body: string, now = Date.now()): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body)) throw new Error("Exoscale status feed: not an RSS document");
  const out: StatusIncident[] = [];
  for (const m of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1]!;
    const title = decode(tag(item, "title"));
    const desc = decode(tag(item, "description"));
    const guid = tag(item, "guid") || tag(item, "link") || title;
    const pub = Date.parse(tag(item, "pubDate"));
    const start = Date.parse(/domain="event:start">([^<]+)</.exec(item)?.[1] ?? "");
    const end = Date.parse(/domain="event:end">([^<]+)</.exec(item)?.[1] ?? "");
    // The newest update's state is the first <strong> after the first <small>.
    const latest =
      /<small>[\s\S]*?<\/small>[\s\S]*?<strong>([^<]+)<\/strong>/
        .exec(desc)?.[1]
        ?.trim()
        .toLowerCase() ?? "";
    if (["resolved", "completed"].includes(latest)) continue;
    if (Number.isFinite(end) && end < now) continue;
    if (!Number.isFinite(end) && Number.isFinite(pub) && now - pub > 14 * 86_400_000) continue;
    const maintenance = /maintenance/i.test(desc.slice(0, 200)) || /maintenance/i.test(title);
    // A maintenance window more than a day away is not affecting anything yet.
    if (maintenance && Number.isFinite(start) && start - now > 86_400_000) continue;
    const text = `${title} ${desc.slice(0, 400)}`;
    const regions = zonesIn(text);
    const services: string[] = [];
    const types: string[] = [];
    for (const [re, service, t] of PRODUCTS) {
      if (re.test(title)) {
        services.push(service);
        types.push(...t);
      }
    }
    const state: StatusIncidentState =
      latest === "monitoring"
        ? "monitoring"
        : latest === "identified"
          ? "identified"
          : "investigating";
    const update = stripStatusHtml(desc).slice(0, 500);
    out.push({
      externalId: guid,
      title: title.replace(/^\[[^\]]+\]\s*/, "") || title,
      state,
      impact: maintenance
        ? "maintenance"
        : /outage|unavailable|down/i.test(text)
          ? "major"
          : "minor",
      url: tag(item, "link") || "https://exoscalestatus.com",
      startedAt: new Date(
        Number.isFinite(start) ? start : Number.isFinite(pub) ? pub : now,
      ).toISOString(),
      ...(update ? { lastUpdateText: update } : {}),
      regions,
      services,
      ...(types.length ? { resourceTypes: types } : {}),
      ...(regions.length === 0 && types.length === 0 ? { providerWide: true } : {}),
    });
  }
  return out;
}
