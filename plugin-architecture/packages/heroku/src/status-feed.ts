/**
 * Heroku public status feed: `GET https://status.heroku.com/api/v4/current-status`
 * (verified 2026-10). It returns the three systems (Apps, Data, Tools) with a
 * colour each, the open `incidents` and the `scheduled` maintenances. Every
 * incident carries `systems` (with their status colour) and region `tags`
 * (`NA`, `EMEA`, `APAC`), which map onto the Heroku regions in each
 * geography. An incident with no tags is treated as provider-wide.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.heroku.com/api/v4/current-status",
  format: "custom-json",
  statusPageUrl: "https://status.heroku.com",
};

export const TAG_REGIONS: Record<string, string[]> = {
  NA: ["us", "virginia", "oregon", "montreal"],
  EMEA: ["eu", "dublin", "frankfurt", "london"],
  APAC: ["tokyo", "sydney", "mumbai", "singapore"],
};

const SYSTEM_TYPES: Record<string, string[]> = {
  Apps: [
    "app",
    "formation",
    "dyno",
    "release",
    "domain",
    "sni-endpoint",
    "log-drain",
    "pipeline",
    "review-app",
    "space",
  ],
  Data: ["add-on"],
};

interface HkStatusIncident {
  id?: number;
  title?: string;
  state?: string;
  created_at?: string;
  resolved_at?: string | null;
  full_url?: string;
  tags?: string[];
  systems?: Array<{ name?: string; status?: string }>;
  updates?: Array<{ created_at?: string; contents?: string; update_type?: string }>;
}

function state(s: string | undefined): StatusIncidentState {
  switch ((s ?? "").toLowerCase()) {
    case "identified":
      return "identified";
    case "monitoring":
      return "monitoring";
    case "resolved":
    case "completed":
      return "resolved";
    default:
      return "investigating";
  }
}

function impact(systems: HkStatusIncident["systems"], maintenance: boolean): StatusIncidentImpact {
  if (maintenance) return "maintenance";
  const colours = (systems ?? []).map((s) => (s.status ?? "").toLowerCase());
  if (colours.includes("red")) return "major";
  return "minor";
}

function toIncident(i: HkStatusIncident, maintenance: boolean): StatusIncident {
  const regions = [...new Set((i.tags ?? []).flatMap((t) => TAG_REGIONS[t] ?? []))];
  const services = [...new Set((i.systems ?? []).map((s) => s.name ?? "").filter(Boolean))];
  const types = [...new Set(services.flatMap((s) => SYSTEM_TYPES[s] ?? []))];
  const latest = [...(i.updates ?? [])].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  )[0];
  const st = state(i.state);
  return {
    externalId: String(i.id ?? i.title ?? ""),
    title: i.title ?? "Heroku incident",
    state: st,
    impact: impact(i.systems, maintenance),
    url: i.full_url ?? `https://status.heroku.com/incidents/${i.id}`,
    startedAt: i.created_at ?? new Date(0).toISOString(),
    ...(st === "resolved" && i.resolved_at ? { resolvedAt: i.resolved_at } : {}),
    ...(latest?.created_at ? { lastUpdateAt: latest.created_at } : {}),
    ...(latest?.contents ? { lastUpdateText: stripStatusHtml(latest.contents) } : {}),
    regions,
    services,
    ...(types.length ? { resourceTypes: types } : {}),
    ...(regions.length === 0 ? { providerWide: true } : {}),
  };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as {
    incidents?: HkStatusIncident[];
    scheduled?: HkStatusIncident[];
  };
  if (!parsed || !Array.isArray(parsed.incidents))
    throw new Error("Heroku status feed: unexpected body");
  const out = parsed.incidents
    .map((i) => toIncident(i, false))
    .filter((i) => i.state !== "resolved");
  for (const m of parsed.scheduled ?? []) {
    // Scheduled maintenance counts only while it is under way.
    if ((m.state ?? "").toLowerCase() !== "in_progress") continue;
    out.push(toIncident({ ...m, state: "monitoring" }, true));
  }
  return out.filter((i) => i.externalId);
}
