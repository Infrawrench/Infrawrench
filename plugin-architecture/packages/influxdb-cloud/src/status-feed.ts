/**
 * InfluxDB Cloud service health (https://status.influxdata.com, Atlassian
 * Statuspage; verified 2026-10). Every region is a component group
 * ("Cloud Serverless: AWS, US-East-1", …) holding the same child names (Web
 * UI, API Writes, API Queries, Tasks, Persistent Storage, Compute, Management
 * API), so an incident's region comes from its components' `group_id`, not
 * their names. The group ids below were read from `/api/v2/summary.json`;
 * they map onto the region ids this plugin stores in `region`. "Cloud
 * Dedicated" is its own group; "Other Services" (sign-in, marketplace) is
 * provider-wide.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

const STATUS_PAGE = "https://status.influxdata.com";

export const statusFeed: StatusFeedDeclaration = {
  url: `${STATUS_PAGE}/api/v2/incidents.json`,
  format: "statuspage-v2",
  statusPageUrl: STATUS_PAGE,
};

export const GROUP_REGIONS: Record<string, string> = {
  "8ggny1z5y5jl": "us-east-1-1",
  "09ylz7krtf65": "eu-central-1-1",
  h6vxc920l94g: "us-west-2-1",
  "40sp5lzmz7fn": "us-west-2-2",
  llp3sllc5hjw: "us-central1-1",
  zk71dc4www40: "westeurope-1",
  y7vrcb204xph: "eastus-1",
};
const DEDICATED_GROUP = "cpj3f450vs2v";

const CLOUD_TYPES = [
  T.bucket,
  T.task,
  T.check,
  T.rule,
  T.endpoint,
  T.dashboard,
  T.token,
  T.org,
  T.telegraf,
];

function typesFor(component: string): string[] {
  switch (component) {
    case "Tasks":
      return [T.task, T.check, T.rule];
    case "API Writes":
    case "API Queries":
    case "API Reads":
    case "Persistent Storage":
      return [T.bucket];
    default:
      return CLOUD_TYPES;
  }
}

interface Incident {
  id?: string;
  name?: string;
  status?: string;
  impact?: string;
  shortlink?: string;
  created_at?: string;
  started_at?: string;
  updated_at?: string;
  resolved_at?: string | null;
  incident_updates?: Array<{ body?: string; created_at?: string }>;
  components?: Array<{ name?: string; group_id?: string | null }>;
}

function state(s: string | undefined): StatusIncidentState {
  if (s === "identified") return "identified";
  if (s === "monitoring" || s === "verifying") return "monitoring";
  if (s === "resolved" || s === "postmortem" || s === "completed") return "resolved";
  return "investigating";
}

function impact(i: string | undefined, s: string | undefined): StatusIncidentImpact {
  if (s === "scheduled" || s === "in_progress" || i === "maintenance") return "maintenance";
  if (i === "critical") return "critical";
  if (i === "major") return "major";
  return "minor";
}

export function parseStatusFeed(body: string, now: number = Date.now()): StatusIncident[] {
  const parsed = JSON.parse(body) as { incidents?: Incident[] };
  if (!Array.isArray(parsed.incidents))
    throw new Error("InfluxData status feed: missing incidents array");
  const cutoff = now - 14 * 24 * 60 * 60 * 1000;
  const out: StatusIncident[] = [];
  for (const i of parsed.incidents) {
    if (!i.id) continue;
    if (i.resolved_at && Date.parse(i.resolved_at) < cutoff) continue;
    const regions = new Set<string>();
    const services = new Set<string>();
    const types = new Set<string>();
    let providerWide = (i.components ?? []).length === 0;
    for (const c of i.components ?? []) {
      const region = c.group_id ? GROUP_REGIONS[c.group_id] : undefined;
      if (region) {
        regions.add(region);
        if (c.name) services.add(c.name);
        typesFor(c.name ?? "").forEach((t) => types.add(t));
      } else if (c.group_id === DEDICATED_GROUP) {
        services.add(`Cloud Dedicated ${c.name ?? ""}`.trim());
        types.add(T.dedicatedDatabase);
        types.add(T.dedicatedToken);
      } else {
        if (c.name) services.add(c.name);
        providerWide = true;
      }
    }
    const latest = i.incident_updates?.[0];
    out.push({
      externalId: i.id,
      title: i.name ?? "InfluxDB Cloud incident",
      state: state(i.status),
      impact: impact(i.impact, i.status),
      ...(i.shortlink ? { url: i.shortlink } : {}),
      startedAt: i.started_at ?? i.created_at ?? new Date(0).toISOString(),
      ...(i.resolved_at ? { resolvedAt: i.resolved_at } : {}),
      ...((latest?.created_at ?? i.updated_at)
        ? { lastUpdateAt: latest?.created_at ?? i.updated_at! }
        : {}),
      ...(latest?.body ? { lastUpdateText: stripStatusHtml(latest.body) } : {}),
      regions: [...regions],
      services: [...services],
      ...(types.size && !providerWide ? { resourceTypes: [...types] } : {}),
      ...(providerWide ? { providerWide: true } : {}),
    });
  }
  return out;
}
