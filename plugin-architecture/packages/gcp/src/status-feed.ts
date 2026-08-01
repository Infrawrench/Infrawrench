/**
 * Google Cloud public status feed
 * (https://status.cloud.google.com/incidents.json — verified 2026-08).
 *
 * Custom JSON: a bare array of incident objects. The useful fields (all
 * verified live): `id`, `begin`, `end` (absent/null while active),
 * `external_desc`, `severity` ("low" | "medium" | "high"),
 * `status_impact` ("AVAILABLE_INFORMATION" | "SERVICE_INFORMATION" |
 * "SERVICE_DISRUPTION" | "SERVICE_OUTAGE"), `uri`,
 * `affected_products[{title}]`,
 * `currently_affected_locations[{id, title}]` where `id` is the exact GCP
 * region slug ("us-central1", "europe-west4", or "global"), and
 * `most_recent_update{when, text}`.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.cloud.google.com/incidents.json",
  format: "custom-json",
  statusPageUrl: "https://status.cloud.google.com",
};

interface GcpIncidentJson {
  id?: string;
  begin?: string;
  end?: string | null;
  modified?: string;
  external_desc?: string;
  severity?: string;
  status_impact?: string;
  uri?: string;
  affected_products?: Array<{ title?: string }>;
  currently_affected_locations?: Array<{ id?: string; title?: string }>;
  previously_affected_locations?: Array<{ id?: string; title?: string }>;
  most_recent_update?: { when?: string; modified?: string; text?: string; status?: string };
}

function impactOf(incident: GcpIncidentJson): StatusIncident["impact"] {
  if (incident.status_impact === "SERVICE_OUTAGE" || incident.severity === "high") {
    return "critical";
  }
  if (incident.status_impact === "SERVICE_DISRUPTION" || incident.severity === "medium") {
    return "major";
  }
  return "minor";
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as GcpIncidentJson[];
  if (!Array.isArray(parsed)) {
    throw new Error("GCP status feed: expected a JSON array of incidents");
  }
  const out: StatusIncident[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw.id !== "string" || raw.id.length === 0) continue;
    const resolved = Boolean(raw.end);
    // The feed carries years of history; only active incidents matter — the
    // host closes cached rows that disappear from the feed.
    if (resolved) continue;
    const locations = (raw.currently_affected_locations ?? [])
      .map((l) => l?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const providerWide = locations.length === 0 || locations.includes("global");
    const update = raw.most_recent_update;
    const lastUpdateAt = update?.modified ?? update?.when;
    out.push({
      externalId: raw.id,
      title: raw.external_desc
        ? stripStatusHtml(raw.external_desc).slice(0, 300)
        : "Google Cloud incident",
      state: "identified",
      impact: impactOf(raw),
      ...(raw.uri
        ? { url: `https://status.cloud.google.com${raw.uri.startsWith("/") ? "" : "/"}${raw.uri}` }
        : { url: statusFeed.statusPageUrl ?? "" }),
      startedAt: raw.begin ?? new Date(0).toISOString(),
      ...(lastUpdateAt ? { lastUpdateAt } : {}),
      ...(update?.text ? { lastUpdateText: stripStatusHtml(update.text).slice(0, 500) } : {}),
      regions: locations.filter((id) => id !== "global"),
      services: (raw.affected_products ?? [])
        .map((p) => p?.title)
        .filter((t): t is string => typeof t === "string" && t.length > 0),
      ...(providerWide ? { providerWide: true } : {}),
    });
  }
  return out;
}
