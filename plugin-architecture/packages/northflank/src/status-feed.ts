/**
 * Northflank's public status page (https://status.northflank.com, an
 * Instatus page; verified 2026-10). Instatus publishes no Statuspage-style
 * incident JSON (`/api/v2/incidents/unresolved.json` redirects to HTML), so
 * the plugin reads the RSS history at `/history.rss`: one `<item>` per
 * incident or maintenance, whose description carries
 *
 *   Type: Incident | Maintenance
 *   Affected Components: Addons, Builds
 *   Sep 4, 18:27:54 GMT+0 - Monitoring - … Sep 4, 20:52:58 GMT+0 - Resolved - …
 *
 * The last "- <State> -" marker is the incident's current state. Components
 * are products, not regions ("Northflank Platform" groups Builds, Networking,
 * Addons, Logs and Metrics, Jobs, Services, Certificates; plus Northflank App
 * and Northflank API), so incidents map to resource types; the API, App and
 * Networking escalate to provider-wide.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.northflank.com/history.rss",
  format: "rss",
  statusPageUrl: "https://status.northflank.com",
};

/** Resolved incidents older than this are history, not news. */
const MAX_RESOLVED_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const COMPONENT_TYPES: Record<string, string[]> = {
  builds: [T.service, T.job],
  services: [T.service],
  jobs: [T.job],
  addons: [T.addon],
  certificates: [T.domain, T.subdomain],
  "logs and metrics": [T.service, T.job, T.addon],
};
const PROVIDER_WIDE = new Set([
  "northflank api",
  "northflank app",
  "networking",
  "northflank platform",
]);
const IGNORED = new Set(["marketing site", "documentation"]);

function stateOf(word: string): StatusIncidentState {
  const w = word.toLowerCase();
  if (w.startsWith("resolved") || w.startsWith("completed")) return "resolved";
  if (w.startsWith("monitoring")) return "monitoring";
  if (w.startsWith("identified")) return "identified";
  return "investigating";
}

export function parseStatusFeed(body: string, now: number = Date.now()): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) {
    throw new Error("Northflank status feed: not an RSS document");
  }
  const out: StatusIncident[] = [];
  for (const item of parseStatusFeedXml(body)) {
    const text = item.description ?? "";
    const isMaintenance = /Type:\s*Maintenance/i.test(text);
    const markers = [
      ...text.matchAll(
        /([A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}:\d{2}) GMT\+0 - (Investigating|Identified|Monitoring|Resolved|Update|Updated|Scheduled|In progress|Inprogress|Verifying|Completed|Notstartedyet|Not started yet)\b[^-]*- ([^]*?)(?=[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}:\d{2} GMT\+0 - |$)/g,
      ),
    ];
    const last = markers[markers.length - 1];
    const state: StatusIncidentState = last ? stateOf(last[2]!) : "investigating";
    const startedAt = item.publishedAt ? new Date(item.publishedAt) : null;
    if (!startedAt || Number.isNaN(startedAt.getTime())) continue;
    const lastUpdate = last ? parseMarkerDate(last[1]!, startedAt) : startedAt;
    if (state === "resolved" && now - lastUpdate.getTime() > MAX_RESOLVED_AGE_MS) continue;
    if (isMaintenance && /Scheduled|Not ?started/i.test(last?.[2] ?? "")) {
      // Planned and not started yet: nothing is affected so far.
      if (startedAt.getTime() > now) continue;
    }
    const components = (
      /Affected Components:\s*(.*?)(?=\s+[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}|\s+Type:|$)/is.exec(
        text,
      )?.[1] ?? ""
    )
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const services: string[] = [];
    const resourceTypes = new Set<string>();
    let providerWide = components.length === 0;
    for (const c of components) {
      const key = c.toLowerCase();
      if (IGNORED.has(key)) continue;
      services.push(c);
      if (PROVIDER_WIDE.has(key)) providerWide = true;
      for (const t of COMPONENT_TYPES[key] ?? []) resourceTypes.add(t);
      if (!COMPONENT_TYPES[key] && !PROVIDER_WIDE.has(key)) providerWide = true;
    }
    if (components.length > 0 && services.length === 0) continue;
    const impact: StatusIncidentImpact = isMaintenance
      ? "maintenance"
      : providerWide
        ? "major"
        : "minor";
    out.push({
      externalId: item.guid,
      title: item.title,
      state,
      impact,
      ...(item.link ? { url: item.link } : {}),
      startedAt: startedAt.toISOString(),
      ...(state === "resolved" ? { resolvedAt: lastUpdate.toISOString() } : {}),
      lastUpdateAt: lastUpdate.toISOString(),
      ...(last?.[3] ? { lastUpdateText: last[3].trim() } : {}),
      regions: [],
      services,
      resourceTypes: [...resourceTypes],
      providerWide,
    });
  }
  return out;
}

/** "Sep 4, 20:52:58" has no year: take the start's year, rolling over at New Year. */
function parseMarkerDate(raw: string, start: Date): Date {
  const year = start.getUTCFullYear();
  let d = new Date(`${raw.replace(",", ` ${year}`)} UTC`);
  if (Number.isNaN(d.getTime())) return start;
  if (d.getTime() < start.getTime() - 24 * 60 * 60 * 1000) {
    d = new Date(`${raw.replace(",", ` ${year + 1}`)} UTC`);
  }
  return d;
}
