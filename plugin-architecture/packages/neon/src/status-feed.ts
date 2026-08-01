/**
 * Neon public status feed (status.io — https://neonstatus.com, verified
 * 2026-08). The machine endpoint is status.io's REST API for the page:
 * https://api.status.io/1.0/status/6878fc85709daa75be6c7e3c
 *
 * Verified shape: `{ result: { status_overall, status: [containers],
 * incidents: [...], maintenance: {...} } }`. Containers are grouped
 * ("Database Connectivity" → children "AWS us-east-1", "Azure eastus2", …)
 * with status.io status codes: 100 Operational, 200 Planned Maintenance,
 * 300 Degraded Performance, 400 Partial Service Disruption, 500 Service
 * Disruption, 600 Security Event.
 *
 * The incidents array was empty at verification time, so incident objects
 * are parsed defensively; independently, any child container reporting a
 * non-operational status is synthesized into an incident so the feature
 * works even if status.io's incident objects differ from expectation.
 *
 * Region mapping: child container names are literally "AWS us-east-1" /
 * "Azure eastus2", and Neon's own region ids (what resources carry in their
 * `region` field) are "aws-us-east-1" / "azure-eastus2" — lowercase and
 * hyphenate.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://api.status.io/1.0/status/6878fc85709daa75be6c7e3c",
  format: "custom-json",
  statusPageUrl: "https://neonstatus.com",
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
  status?: string;
  current_status?: string;
  datetime_open?: string;
  datetime_opened?: string;
  containers_affected?: Array<{ name?: string; _id?: string }>;
  components_affected?: Array<{ name?: string; _id?: string }>;
  messages?: Array<{ details?: string; datetime?: string; status?: string }>;
}

interface StatusIoResponse {
  result?: {
    status?: StatusIoContainer[];
    incidents?: StatusIoIncident[];
  };
}

/** "AWS us-east-1" → "aws-us-east-1"; "Azure eastus2" → "azure-eastus2". */
function containerToRegion(name: string): string | null {
  const match = name.match(/^(AWS|Azure)\s+([a-z0-9-]+)$/i);
  if (!match || !match[1] || !match[2]) return null;
  return `${match[1].toLowerCase()}-${match[2].toLowerCase()}`;
}

function impactFromStatusCode(code: number): StatusIncident["impact"] {
  if (code >= 500) return "critical";
  if (code >= 400) return "major";
  if (code >= 300) return "minor";
  return "maintenance";
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as StatusIoResponse;
  const result = parsed.result;
  if (!result || !Array.isArray(result.status)) {
    throw new Error("Neon status feed: missing result.status containers");
  }
  const out: StatusIncident[] = [];
  const now = new Date().toISOString();

  // Explicit incidents, parsed defensively.
  for (const raw of result.incidents ?? []) {
    if (!raw) continue;
    const externalId = raw.id ?? raw._id ?? raw.name;
    if (!externalId) continue;
    const affected = [...(raw.containers_affected ?? []), ...(raw.components_affected ?? [])]
      .map((c) => c?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    const regions = affected.map(containerToRegion).filter((r): r is string => r !== null);
    const services = affected.filter((n) => containerToRegion(n) === null);
    const latest = raw.messages?.[0];
    out.push({
      externalId: String(externalId),
      title: raw.name ? stripStatusHtml(raw.name).slice(0, 300) : "Neon incident",
      state: "identified",
      impact: "major",
      url: statusFeed.statusPageUrl ?? statusFeed.url,
      startedAt: raw.datetime_open ?? raw.datetime_opened ?? now,
      ...(latest?.details ? { lastUpdateText: stripStatusHtml(latest.details).slice(0, 500) } : {}),
      ...(latest?.datetime ? { lastUpdateAt: latest.datetime } : {}),
      regions,
      services,
      ...(affected.length === 0 ? { providerWide: true } : {}),
    });
  }

  // Synthesized incidents from degraded containers, deduped against the
  // explicit list by region so a properly-reported incident wins.
  const coveredRegions = new Set(out.flatMap((i) => i.regions));
  for (const group of result.status) {
    for (const child of group?.containers ?? []) {
      const code = child?.status_code ?? 100;
      const name = child?.name?.trim();
      if (!name || code < 300) continue;
      const region = containerToRegion(name);
      if (region && coveredRegions.has(region)) continue;
      out.push({
        externalId: `container:${child.id ?? child._id ?? name}`,
        title: `${group?.name ?? "Neon"} ${child.status ?? "degraded"} — ${name}`,
        state: "investigating",
        impact: impactFromStatusCode(code),
        url: statusFeed.statusPageUrl ?? statusFeed.url,
        startedAt: child.updated ?? now,
        regions: region ? [region] : [],
        services: [group?.name ?? name],
        ...(region ? {} : { providerWide: true }),
      });
    }
  }

  return out;
}
