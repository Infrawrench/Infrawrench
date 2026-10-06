/**
 * Railway public status feed. status.railway.com is Railway's own status
 * app (not Statuspage); the page reads `GET /api/status`, a public JSON
 * document with `activeIncidents`, `recentIncidents` and `maintenances`
 * (verified 2026-10). Each incident lists its components with the group
 * they sit in, and the regional groups ("US East (Virginia, USA)", …) map
 * one-to-one onto Railway region ids.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
} from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.railway.com/api/status",
  format: "custom-json",
  statusPageUrl: "https://status.railway.com",
};

export const REGION_GROUPS: Record<string, string> = {
  "US West (California, USA)": "us-west2",
  "US East (Virginia, USA)": "us-east4-eqdc4a",
  "EU West (Amsterdam, Netherlands)": "europe-west4-drams3a",
  "Southeast Asia (Singapore)": "asia-southeast1-eqsg3a",
};

const COMPONENT_TYPES: Record<string, string[]> = {
  Builds: ["service", "deployment"],
  Deployments: ["service", "deployment"],
  Compute: ["service"],
  Storage: ["volume"],
  "Networking — Public": ["service", "domain", "tcp-proxy"],
  "Networking — Private": ["service"],
};

/** Components whose incidents reach every Railway resource. */
const PROVIDER_WIDE = /^(API|Dashboard)\b/;
/** Groups and components that never affect running infrastructure. */
const IGNORED_GROUPS = new Set(["Authentication", "Payments & Billing"]);

interface FeedComponent {
  name?: string;
  groupName?: string | null;
  impact?: string;
}

interface FeedIncident {
  id?: string;
  slug?: string;
  title?: string;
  status?: string;
  createdAt?: string;
  resolvedAt?: string | null;
  components?: FeedComponent[];
  updates?: Array<{ status?: string; message?: string; createdAt?: string }>;
}

function state(s: string | undefined): StatusIncidentState {
  switch ((s ?? "").toUpperCase()) {
    case "IDENTIFIED":
      return "identified";
    case "MONITORING":
      return "monitoring";
    case "RESOLVED":
    case "COMPLETED":
      return "resolved";
    default:
      return "investigating";
  }
}

const IMPACT_ORDER: StatusIncidentImpact[] = ["maintenance", "minor", "major", "critical"];

function impactOf(components: FeedComponent[]): StatusIncidentImpact {
  let worst: StatusIncidentImpact = "minor";
  for (const c of components) {
    const i = (c.impact ?? "").toUpperCase();
    const mapped: StatusIncidentImpact =
      i === "MAJOR_OUTAGE" || i === "FULL_OUTAGE"
        ? "critical"
        : i === "PARTIAL_OUTAGE"
          ? "major"
          : i === "UNDER_MAINTENANCE"
            ? "maintenance"
            : "minor";
    if (IMPACT_ORDER.indexOf(mapped) > IMPACT_ORDER.indexOf(worst)) worst = mapped;
  }
  return worst;
}

function toIncident(i: FeedIncident, maintenance: boolean): StatusIncident | null {
  const components = i.components ?? [];
  const regions = new Set<string>();
  const services = new Set<string>();
  const types = new Set<string>();
  let providerWide = false;
  let relevant = components.length === 0;
  for (const c of components) {
    const group = c.groupName ?? "";
    const name = c.name ?? "";
    if (IGNORED_GROUPS.has(group) || IGNORED_GROUPS.has(name)) continue;
    relevant = true;
    const region = REGION_GROUPS[group];
    if (region) regions.add(region);
    services.add(region ? name : [group, name].filter(Boolean).join(": "));
    for (const t of COMPONENT_TYPES[name] ?? []) types.add(t);
    if (group === "Railway" && PROVIDER_WIDE.test(name)) providerWide = true;
  }
  if (!relevant) return null;
  if (components.length === 0) providerWide = true;
  const updates = [...(i.updates ?? [])].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
  const latest = updates[0];
  const st = state(i.status);
  return {
    externalId: i.id ?? i.slug ?? i.title ?? "",
    title: i.title ?? "Railway incident",
    state: st,
    impact: maintenance ? "maintenance" : impactOf(components),
    url: i.slug ? `https://status.railway.com/incident/${i.slug}` : "https://status.railway.com",
    startedAt: i.createdAt ?? new Date(0).toISOString(),
    ...(i.resolvedAt && st === "resolved" ? { resolvedAt: i.resolvedAt } : {}),
    ...(latest?.createdAt ? { lastUpdateAt: latest.createdAt } : {}),
    ...(latest?.message ? { lastUpdateText: latest.message } : {}),
    regions: [...regions],
    services: [...services],
    ...(types.size ? { resourceTypes: [...types] } : {}),
    ...(providerWide ? { providerWide: true } : {}),
  };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as {
    activeIncidents?: FeedIncident[];
    maintenances?: FeedIncident[];
  };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.activeIncidents)) {
    throw new Error("Railway status feed: unexpected body");
  }
  const out: StatusIncident[] = [];
  for (const i of parsed.activeIncidents) {
    const inc = toIncident(i, false);
    if (inc && inc.state !== "resolved") out.push(inc);
  }
  for (const m of parsed.maintenances ?? []) {
    if (!/IN_PROGRESS|ACTIVE/i.test(m.status ?? "")) continue;
    const inc = toIncident({ ...m, status: "MONITORING" }, true);
    if (inc) out.push(inc);
  }
  return out.filter((i) => i.externalId);
}
