/**
 * boat's status page (https://status.boat.dev, checked 2026-11) is a static
 * page of its own, not a hosted status product. The page reads
 * `/status.json`: `{checkedAt, components: [{name, checkedAt, status,
 * latencyMs, message}], announcements: [{title, body?, severity, createdAt}]}`,
 * where a component's status is `operational`, `degraded`, `outage` or
 * `unknown` (the page reads anything else as `outage`), and an announcement's
 * severity is `critical`, `warning` or `info`.
 *
 * Components are synthetic probes ("Box Creation", "Box SSH", "Box Fork", ...),
 * so there are no incidents with ids or lifecycles. Each failing probe becomes
 * one incident keyed by its name, which keeps it the same incident for as long
 * as the probe fails; each announcement becomes one keyed by title and time.
 * boat called sandboxes boxes before the rename, which the probe names keep.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
} from "@infrawrench/plugin-base";

export const STATUS_PAGE_URL = "https://status.boat.dev";

export const statusFeed: StatusFeedDeclaration = {
  url: `${STATUS_PAGE_URL}/status.json`,
  format: "custom-json",
  statusPageUrl: STATUS_PAGE_URL,
};

export function mapComponent(name: string): StatusComponentMapping | null {
  if (name === "Box Dashboard") return null;
  if (name === "Ascii API") return { services: ["API"], providerWide: true };
  if (name.startsWith("Box Stop + Resume"))
    return { services: ["Stop and resume"], resourceTypes: ["sandbox"] };
  if (name === "Box Fork") return { services: ["Fork"], resourceTypes: ["sandbox"] };
  if (name === "Box SSH") return { services: ["SSH"], resourceTypes: ["sandbox"] };
  if (name === "Box Desktop Streaming")
    return { services: ["Desktop streaming"], resourceTypes: ["sandbox"] };
  if (name === "Box Creation")
    return { services: ["Sandbox creation"], resourceTypes: ["sandbox"] };
  return { services: [name.replace(/^Box /, "")] };
}

interface FeedComponent {
  name?: unknown;
  status?: unknown;
  checkedAt?: unknown;
  message?: unknown;
}

interface FeedAnnouncement {
  title?: unknown;
  body?: unknown;
  severity?: unknown;
  createdAt?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const ANNOUNCEMENT_IMPACT: Record<string, StatusIncidentImpact> = {
  critical: "critical",
  warning: "minor",
};

export function parseStatusFeed(body: string): StatusIncident[] {
  const doc = JSON.parse(body) as {
    checkedAt?: unknown;
    components?: unknown;
    announcements?: unknown;
  };
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.components)) {
    throw new Error("boat status feed: no components list");
  }
  const checkedAt = str(doc.checkedAt) || new Date().toISOString();
  const incidents: StatusIncident[] = [];
  for (const c of doc.components as FeedComponent[]) {
    const name = str(c.name);
    const status = str(c.status);
    // `unknown` is a probe with no recent data, not a failure.
    if (!name || status === "operational" || status === "unknown") continue;
    const mapping = mapComponent(name);
    if (!mapping) continue;
    const message = str(c.message);
    incidents.push({
      externalId: `component:${name}`,
      title: `${name}: ${status === "degraded" ? "degraded" : "outage"}`,
      state: "investigating",
      impact: status === "degraded" ? "minor" : "major",
      url: STATUS_PAGE_URL,
      startedAt: str(c.checkedAt) || checkedAt,
      lastUpdateAt: str(c.checkedAt) || checkedAt,
      ...(message ? { lastUpdateText: message } : {}),
      regions: [],
      services: mapping.services ?? [name],
      ...(mapping.resourceTypes ? { resourceTypes: mapping.resourceTypes } : {}),
      providerWide: mapping.providerWide ?? false,
    });
  }
  for (const a of (Array.isArray(doc.announcements)
    ? doc.announcements
    : []) as FeedAnnouncement[]) {
    const title = str(a.title);
    const impact = ANNOUNCEMENT_IMPACT[str(a.severity)];
    // An `info` announcement is news, not an incident.
    if (!title || !impact) continue;
    const createdAt = str(a.createdAt) || checkedAt;
    const text = str(a.body);
    incidents.push({
      externalId: `announcement:${createdAt}:${title}`,
      title,
      state: "identified",
      impact,
      url: STATUS_PAGE_URL,
      startedAt: createdAt,
      lastUpdateAt: createdAt,
      ...(text ? { lastUpdateText: text } : {}),
      regions: [],
      services: [],
      providerWide: true,
    });
  }
  return incidents;
}
