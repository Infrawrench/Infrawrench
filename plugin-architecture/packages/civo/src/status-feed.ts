/**
 * Civo's status page (https://status.civo.com) is a cState site, not
 * Statuspage: it publishes an RSS feed of issues at `/index.xml` (checked
 * 2026-10-06). Systems are named `Compute/LON1`, `Storage/FRA1`,
 * `Network/NYC1`, plus global "Civo API" and "Load Balancers"; issue titles
 * carry the region code ("Degraded storage and network performance in
 * LON1") and resolved issues are prefixed "[Resolved]".
 */

import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatusFeedXml, stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.civo.com/index.xml",
  format: "rss",
  statusPageUrl: "https://status.civo.com",
};

const ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const REGION = /\b(LON1|FRA1|NYC1|PHX1|MUM1|[A-Z]{3}\d)\b/g;

const PRODUCTS: Array<[RegExp, string, string[]]> = [
  [/kubernetes|k3s|cluster/i, "Kubernetes", ["kubernetes-cluster", "node-pool"]],
  [/database|dbaas|mysql|postgres/i, "Databases", ["database", "database-backup"]],
  [/object store|objectstore|s3/i, "Object Storage", ["object-store", "object-store-credential"]],
  [/load ?balancer/i, "Load Balancers", ["load-balancer"]],
  [/volume|storage/i, "Storage", ["volume", "volume-snapshot"]],
  [/dns/i, "DNS", ["domain", "dns-record"]],
];

export function regionsIn(text: string): string[] {
  return [...new Set([...text.matchAll(REGION)].map((m) => m[1]!.toLowerCase()))];
}

export function parseStatusFeed(body: string, now = Date.now()): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body)) throw new Error("Civo status feed: not an RSS document");
  const out: StatusIncident[] = [];
  for (const item of parseStatusFeedXml(body)) {
    const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    if (Number.isNaN(published) || now - published > ACTIVE_WINDOW_MS) continue;
    if (/^\s*\[resolved\]/i.test(item.title)) continue;
    const text = `${item.title} ${item.description ?? ""}`;
    const regions = regionsIn(item.title).length ? regionsIn(item.title) : regionsIn(text);
    const services: string[] = [];
    const resourceTypes: string[] = [];
    for (const [re, service, types] of PRODUCTS) {
      if (re.test(item.title)) {
        services.push(service);
        resourceTypes.push(...types);
      }
    }
    const maintenance = /maintenance|scheduled/i.test(item.title);
    const description = item.description
      ? stripStatusHtml(item.description).slice(0, 500)
      : undefined;
    out.push({
      externalId: item.guid,
      title: item.title.replace(/^\s*\[[^\]]+\]\s*/, ""),
      state: /monitoring/i.test(item.title) ? "monitoring" : "investigating",
      impact: maintenance
        ? "maintenance"
        : /outage|down|unavailable/i.test(item.title)
          ? "major"
          : "minor",
      url: item.link ?? statusFeed.statusPageUrl!,
      startedAt: new Date(published).toISOString(),
      ...(description ? { lastUpdateText: description } : {}),
      regions,
      services,
      ...(resourceTypes.length ? { resourceTypes } : {}),
      ...(regions.length === 0 && resourceTypes.length === 0 ? { providerWide: true } : {}),
    });
  }
  return out;
}
