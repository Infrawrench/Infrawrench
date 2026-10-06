/**
 * GitLab.com's public status page (https://status.gitlab.com) is hosted on
 * status.io (page id `5b36dc6502d06804c08349f7`, verified 2026-10 from the
 * page's `x-status-page-id` header). The machine endpoint is status.io's
 * public REST API for the page:
 * `{ result: { status_overall, status: [components], incidents, maintenance } }`.
 *
 * Components are GitLab products ("API", "Git Operations", "CI/CD - Hosted
 * runners on Linux", "Container Registry", "Package Registry", "GitLab Pages",
 * ...), each with a status.io code: 100 operational, 200 planned maintenance,
 * 300 degraded performance, 400 partial disruption, 500 disruption, 600
 * security event. They map onto service names; API and Website outages
 * escalate to provider-wide since every listing depends on them.
 *
 * Incidents are parsed defensively (their objects are only present while an
 * incident is open), and any component reporting 300+ without an explicit
 * incident is synthesised into one, so a degraded component is never missed.
 *
 * The feed only describes GitLab.com; self-managed instances have no public
 * status, and their incidents are not GitLab's.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://api.status.io/1.0/status/5b36dc6502d06804c08349f7",
  format: "custom-json",
  statusPageUrl: "https://status.gitlab.com",
};

interface StatusIoComponent {
  id?: string;
  _id?: string;
  name?: string;
  status?: string;
  status_code?: number;
  updated?: string;
}

interface StatusIoIncident {
  id?: string;
  _id?: string;
  name?: string;
  datetime_open?: string;
  containers_affected?: Array<{ name?: string }>;
  components_affected?: Array<{ name?: string }>;
  messages?: Array<{
    details?: string;
    datetime?: string;
    state?: number | string;
    status?: number;
  }>;
}

interface StatusIoResponse {
  result?: {
    status?: StatusIoComponent[];
    incidents?: StatusIoIncident[];
    maintenance?: { active?: StatusIoIncident[] };
  };
}

const PROVIDER_WIDE = new Set(["API", "Website"]);

/** Which of this plugin's resource types a component's outage touches. */
const TYPES_BY_SERVICE: Record<string, string[]> = {
  "CI/CD": ["pipeline", "pipeline-schedule", "runner", "environment"],
  "Container Registry": ["container-repository"],
  "Package Registry": ["package"],
  "Git Operations": ["project", "protected-branch", "deploy-key", "deploy-token"],
};

interface ComponentMapping {
  service: string;
  providerWide: boolean;
  resourceTypes: string[];
}

/** Component name to the service it is filed under and the types it touches. */
export function mapComponent(name: string): ComponentMapping | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (PROVIDER_WIDE.has(trimmed))
    return { service: trimmed, providerWide: true, resourceTypes: [] };
  const service = /^CI\/CD\b/i.test(trimmed) ? "CI/CD" : trimmed;
  return { service, providerWide: false, resourceTypes: TYPES_BY_SERVICE[service] ?? [] };
}

function impactOf(code: number): StatusIncident["impact"] {
  if (code >= 500) return "critical";
  if (code >= 400) return "major";
  if (code >= 300) return "minor";
  return "maintenance";
}

/** status.io message states: 100 investigating, 200 identified, 300 monitoring, (400) resolved. */
function stateOf(raw: number | string | undefined): StatusIncident["state"] {
  const s = String(raw ?? "").toLowerCase();
  if (s === "200" || s.includes("identified")) return "identified";
  if (s === "300" || s.includes("monitor")) return "monitoring";
  if (s === "400" || s.includes("resolved")) return "resolved";
  return "investigating";
}

const EPOCH = new Date(0).toISOString();

function iso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function fromIncident(raw: StatusIoIncident, maintenance: boolean): StatusIncident | null {
  const externalId = raw.id ?? raw._id ?? raw.name;
  if (!externalId) return null;
  const names = [...(raw.components_affected ?? []), ...(raw.containers_affected ?? [])]
    .map((c) => c?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  const mapped = names.map(mapComponent).filter((m): m is NonNullable<typeof m> => m !== null);
  const latest = [...(raw.messages ?? [])]
    .filter((m) => m?.datetime && !Number.isNaN(Date.parse(m.datetime)))
    .sort((a, b) => Date.parse(b.datetime!) - Date.parse(a.datetime!))[0];
  const state = stateOf(latest?.state);
  const lastUpdateAt = iso(latest?.datetime);
  return {
    externalId: String(externalId),
    title: raw.name ? stripStatusHtml(raw.name).slice(0, 300) : "GitLab.com incident",
    state,
    impact: maintenance
      ? "maintenance"
      : impactOf(typeof latest?.status === "number" ? latest.status : 400),
    url: statusFeed.statusPageUrl ?? statusFeed.url,
    startedAt: iso(raw.datetime_open) ?? EPOCH,
    ...(latest?.details ? { lastUpdateText: stripStatusHtml(latest.details).slice(0, 500) } : {}),
    ...(lastUpdateAt ? { lastUpdateAt } : {}),
    regions: [],
    services: [...new Set(mapped.map((m) => m.service))],
    resourceTypes: [...new Set(mapped.flatMap((m) => m.resourceTypes))],
    ...(mapped.length === 0 || mapped.some((m) => m.providerWide) ? { providerWide: true } : {}),
  };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as StatusIoResponse;
  const result = parsed.result;
  if (!result || !Array.isArray(result.status)) {
    throw new Error("GitLab status feed: missing result.status components");
  }
  const out: StatusIncident[] = [];
  for (const raw of result.incidents ?? []) {
    const incident = raw ? fromIncident(raw, false) : null;
    if (incident && incident.state !== "resolved") out.push(incident);
  }
  for (const raw of result.maintenance?.active ?? []) {
    const incident = raw ? fromIncident(raw, true) : null;
    if (incident) out.push(incident);
  }
  const covered = new Set(out.flatMap((i) => i.services));
  const anyProviderWide = out.some((i) => i.providerWide);
  for (const c of result.status) {
    const code = c?.status_code ?? 100;
    const name = c?.name?.trim();
    if (!name || code < 300 || anyProviderWide) continue;
    const mapped = mapComponent(name);
    if (!mapped || covered.has(mapped.service)) continue;
    covered.add(mapped.service);
    out.push({
      externalId: `component:${c.id ?? c._id ?? name}`,
      title: `${name}: ${c.status ?? "degraded"}`,
      state: "investigating",
      impact: impactOf(code),
      url: statusFeed.statusPageUrl ?? statusFeed.url,
      startedAt: iso(c.updated) ?? EPOCH,
      regions: [],
      services: [mapped.service],
      resourceTypes: mapped.resourceTypes,
      ...(mapped.providerWide ? { providerWide: true } : {}),
    });
  }
  return out;
}
