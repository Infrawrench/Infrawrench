/**
 * Supabase public status feed (https://status.supabase.com, incident.io
 * emulating the Statuspage v2 API: verified 2026-10-12, when the page had
 * moved off Atlassian Statuspage).
 *
 * incident.io hosts 404 on /incidents/unresolved.json, so this reads
 * /api/v2/incidents.json (recent history) and keeps the unresolved ones.
 * incident.io incidents carry no components today, so they arrive
 * provider-wide; the mapper below applies if components come back.
 *
 * Components are either AWS regions named exactly as the Management API
 * reports a project's `region` ("us-east-1", "eu-central-2", …), or product
 * services ("Database", "Auth", "Storage", "Edge Functions", "Realtime",
 * "Connection Pooler", "API Gateway", "Analytics", "Management API",
 * "Dashboard", "Compute capacity"). Regions map 1:1 onto `fields.region`;
 * service components scope to the matching resource types. The dashboard and
 * Management API are what this plugin itself talks to, so they escalate to
 * provider-wide.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.supabase.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.supabase.com",
};

const REGION = /^[a-z]{2}-[a-z]+-\d$/;

const SERVICE_TYPES: Record<string, string[]> = {
  Database: ["supabase-project", "supabase-branch", "supabase-read-replica", "supabase-backup"],
  "Connection Pooler": ["supabase-project", "supabase-read-replica"],
  Auth: [
    "supabase-auth",
    "supabase-sso-provider",
    "supabase-third-party-auth",
    "supabase-signing-key",
  ],
  Storage: ["supabase-bucket"],
  "Edge Functions": ["supabase-function", "supabase-secret"],
  Realtime: ["supabase-project"],
  "API Gateway": ["supabase-project", "supabase-api-key"],
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (REGION.test(trimmed)) return { regions: [trimmed] };
  if (trimmed === "Management API" || trimmed === "Dashboard") {
    return { services: [trimmed], providerWide: true };
  }
  const types = SERVICE_TYPES[trimmed];
  if (types) return { services: [trimmed], resourceTypes: types };
  return { services: [trimmed] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  // The feed is history: keep only active incidents; the host closes cached
  // rows that disappear from the parsed set.
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((incident) => incident.state !== "resolved" && !incident.resolvedAt);
}
