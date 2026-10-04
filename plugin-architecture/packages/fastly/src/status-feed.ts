/**
 * Fastly public status feed (StatusCast RSS, https://www.fastlystatus.com/rss/:
 * verified 2026-10; the page has no Statuspage JSON API).
 *
 * Every item is one *post*; an incident is the set of posts sharing the first
 * segment of the guid (`/378892/817466` is post 817466 of incident 378892),
 * and the feed is newest first. An incident is active when its newest post
 * does not read as finished. Retrospectives (posted after the fact, already
 * over) and announcements are history, not incidents.
 *
 * Fastly resources are global, so incidents are not scoped to regions: a POP
 * incident ("Ashburn (IAD)") is reported under its POP code as a display-only
 * service, and product incidents (Compute, Object Storage, Image Optimizer,
 * the API) under the product. Core delivery and API incidents are
 * provider-wide.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";

const STATUS_PAGE = "https://www.fastlystatus.com";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.fastlystatus.com/rss/",
  format: "rss",
  statusPageUrl: STATUS_PAGE,
};

/** Posts older than this are history even if they never said "resolved". */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const FINISHED =
  /\b(resolved|fully restored|has been restored|been completed|is complete|completed|mitigated and resolved)\b/i;
const NOT_AN_INCIDENT = /^(retrospective|announcing|announcement|changes to|notice)\b/i;
const MAINTENANCE = /\bmaintenance\b|capacity expansion/i;
const POP_CODE = /\(([A-Z]{3})\)/g;

/** Products named in titles, mapped to the label and the types they affect. */
const PRODUCTS: Array<{ match: RegExp; service: string; resourceTypes?: string[] }> = [
  { match: /\bcompute\b/i, service: "Compute", resourceTypes: ["service"] },
  { match: /object storage/i, service: "Object Storage" },
  { match: /image optimi[sz]er/i, service: "Image Optimizer", resourceTypes: ["service"] },
  { match: /next-gen waf|ngwaf|\bwaf\b/i, service: "Next-Gen WAF", resourceTypes: ["service"] },
  {
    match: /log(ging)? (streaming|explorer)|real-time log/i,
    service: "Log streaming",
    resourceTypes: ["logging-endpoint"],
  },
  { match: /\btls\b|certificate/i, service: "TLS", resourceTypes: ["tls-subscription"] },
  { match: /kv store|config store|secret store/i, service: "Edge data stores" },
];
const PROVIDER_WIDE = /\bapi\b|purg|\bdelivery\b|global|configuration|control panel|\bcdn\b/i;
const IGNORED = /support (portal|ticketing)|chatbot|community|billing portal/i;

export function parseStatusFeed(body: string): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body)) throw new Error("Fastly status feed: not an RSS document");
  const items = parseStatusFeedXml(body);
  const posts = new Map<string, typeof items>();
  for (const item of items) {
    const incidentId = item.guid.split("/").filter(Boolean)[0] ?? item.guid;
    const list = posts.get(incidentId) ?? [];
    list.push(item);
    posts.set(incidentId, list);
  }

  const now = Date.now();
  const out: StatusIncident[] = [];
  for (const [incidentId, list] of posts) {
    const dated = list
      .map((p) => ({ p, t: p.publishedAt ? Date.parse(p.publishedAt) : NaN }))
      .filter((x) => !Number.isNaN(x.t))
      .sort((a, b) => b.t - a.t);
    const latest = dated[0];
    const first = dated[dated.length - 1];
    if (!latest || !first) continue;
    const title = latest.p.title.trim();
    if (NOT_AN_INCIDENT.test(title) || IGNORED.test(title)) continue;
    if (now - latest.t > ACTIVE_WINDOW_MS) continue;
    if (FINISHED.test(latest.p.description ?? "")) continue;

    const services = new Set<string>();
    const resourceTypes = new Set<string>();
    for (const m of title.matchAll(POP_CODE)) if (m[1]) services.add(`POP ${m[1]}`);
    for (const p of PRODUCTS) {
      if (p.match.test(title)) {
        services.add(p.service);
        for (const t of p.resourceTypes ?? []) resourceTypes.add(t);
      }
    }
    const maintenance = MAINTENANCE.test(title);
    const providerWide = !maintenance && (PROVIDER_WIDE.test(title) || services.size === 0);
    const text = (latest.p.description ?? "").slice(0, 500);
    out.push({
      externalId: incidentId,
      title,
      state: /identified|contributing factor|fix/i.test(text)
        ? "identified"
        : /monitor|recovery|mitigated/i.test(text)
          ? "monitoring"
          : "investigating",
      impact: maintenance ? "maintenance" : /outage|unavailable/i.test(title) ? "major" : "minor",
      url: latest.p.link ?? first.p.link ?? STATUS_PAGE,
      startedAt: new Date(first.t).toISOString(),
      lastUpdateAt: new Date(latest.t).toISOString(),
      ...(text ? { lastUpdateText: text } : {}),
      regions: [],
      services: [...services],
      ...(resourceTypes.size > 0 ? { resourceTypes: [...resourceTypes] } : {}),
      ...(providerWide ? { providerWide: true } : {}),
    });
  }
  return out;
}
