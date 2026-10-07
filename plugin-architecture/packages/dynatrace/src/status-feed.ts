/**
 * Dynatrace public status feed. status.dynatrace.com redirects to a status.io
 * page (dynatrace.status.io, page id `546d8cb6af8407b6730000cb`, verified
 * 2026-10), whose machine-readable form is status.io's public REST API:
 * `{ result: { status_overall, status: [containers], incidents: [...] } }`.
 *
 * Containers (verified live): a "Dynatrace Product" group whose children are
 * `<Stage>-<Cloud>-<geo>` (`Process-AWS-americas`, `Analyze-GCP-emea`,
 * `Automate-Azure-asia-pacific`, …) and a "Dynatrace ecosystem services"
 * group (Support Portal, University, Community, Search, Managed, Website,
 * Hub, Account Management). status.io codes: 100 operational, 200 planned
 * maintenance, 300 degraded, 400 partial disruption, 500 disruption.
 *
 * The API does not say which cloud and geography an environment runs in, so
 * product incidents are scoped to the environment resource type (every
 * connected environment is shown as possibly affected) and carry the
 * `<cloud>-<geo>` slug as the region for display. Ecosystem services that do
 * not touch a running environment are ignored.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://api.status.io/1.0/status/546d8cb6af8407b6730000cb",
  format: "custom-json",
  statusPageUrl: "https://status.dynatrace.com",
};

interface StatusIoContainer {
  id?: string;
  _id?: string;
  name?: string;
  status?: string;
  status_code?: number;
  updated?: string;
  containers?: StatusIoContainer[];
}

interface StatusIoIncident {
  id?: string;
  _id?: string;
  name?: string;
  datetime_open?: string;
  containers_affected?: Array<{ name?: string }>;
  components_affected?: Array<{ name?: string }>;
  messages?: Array<{ details?: string; datetime?: string; status?: number | string }>;
}

const IGNORED = new Set([
  "Dynatrace Support Portal",
  "Dynatrace University",
  "Dynatrace Community",
  "Dynatrace Search",
  "Dynatrace Website",
  "Dynatrace Hub",
]);

/** `Process-AWS-americas` → `{ service: "Process", region: "aws-americas" }`. */
export function parseContainer(name: string): { service: string; region?: string } | null {
  if (IGNORED.has(name)) return null;
  const m = /^([A-Za-z]+)-(AWS|Azure|GCP)-([a-z-]+)$/i.exec(name.trim());
  if (m?.[1] && m[2] && m[3]) {
    return { service: m[1], region: `${m[2].toLowerCase()}-${m[3].toLowerCase()}` };
  }
  return { service: name };
}

function impactFor(code: number): StatusIncident["impact"] {
  if (code >= 500) return "critical";
  if (code >= 400) return "major";
  if (code >= 300) return "minor";
  return "maintenance";
}

function iso(value: string | undefined): string {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? new Date(0).toISOString() : new Date(ms).toISOString();
}

function scopeOf(names: string[]): Pick<StatusIncident, "regions" | "services" | "resourceTypes"> {
  const parsed = names
    .map(parseContainer)
    .filter((p): p is { service: string; region?: string } => p !== null);
  return {
    regions: Array.from(
      new Set(parsed.map((p) => p.region).filter((r): r is string => Boolean(r))),
    ),
    services: Array.from(new Set(parsed.map((p) => p.service))),
    resourceTypes: ["environment"],
  };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as {
    result?: { status?: StatusIoContainer[]; incidents?: StatusIoIncident[] };
  };
  const result = parsed.result;
  if (!result || !Array.isArray(result.status)) {
    throw new Error("Dynatrace status feed: missing result.status containers");
  }
  const out: StatusIncident[] = [];
  const covered = new Set<string>();
  const pageUrl = statusFeed.statusPageUrl ?? statusFeed.url;

  for (const raw of result.incidents ?? []) {
    const externalId = raw.id ?? raw._id ?? raw.name;
    if (!externalId) continue;
    const names = [...(raw.containers_affected ?? []), ...(raw.components_affected ?? [])]
      .map((c) => c.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    for (const n of names) covered.add(n);
    const scope = scopeOf(names);
    if (names.length > 0 && scope.services?.length === 0) continue;
    const latest = [...(raw.messages ?? [])]
      .filter((m) => m.datetime && !Number.isNaN(Date.parse(m.datetime)))
      .sort((a, b) => Date.parse(b.datetime ?? "") - Date.parse(a.datetime ?? ""))[0];
    out.push({
      externalId: String(externalId),
      title: raw.name ? stripStatusHtml(raw.name).slice(0, 300) : "Dynatrace incident",
      state: "identified",
      impact: "major",
      url: pageUrl,
      startedAt: iso(raw.datetime_open),
      ...(latest?.details ? { lastUpdateText: stripStatusHtml(latest.details).slice(0, 500) } : {}),
      ...(latest?.datetime ? { lastUpdateAt: iso(latest.datetime) } : {}),
      ...scope,
      ...(names.length === 0 ? { providerWide: true } : {}),
    });
  }

  // Containers reporting trouble without an incident object: synthesise one
  // per container so a degraded region still shows.
  for (const group of result.status) {
    for (const c of group.containers ?? []) {
      const code = c.status_code ?? 100;
      if (code <= 100 || !c.name || covered.has(c.name)) continue;
      const scope = scopeOf([c.name]);
      if (scope.services?.length === 0) continue;
      out.push({
        externalId: `container-${c.id ?? c._id ?? c.name}`,
        title: `${c.name}: ${c.status ?? "degraded"}`,
        state: code === 200 ? "monitoring" : "identified",
        impact: impactFor(code),
        url: pageUrl,
        startedAt: iso(c.updated),
        ...scope,
      });
    }
  }
  return out;
}
