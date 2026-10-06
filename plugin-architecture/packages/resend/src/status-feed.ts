/**
 * Resend public status feed: incident.io emulating the Statuspage v2 API at
 * https://resend-status.com (`status.resend.com` redirects there; verified
 * 2026-10-06). incident.io hosts 404 on `/incidents/unresolved.json`, so this
 * fetches `/api/v2/incidents.json` (recent history) and keeps the unresolved
 * ones. Its incidents carry no components, so they read as provider-wide; the
 * component mapper covers the published components (Single Email, Batch
 * Emails, Broadcast Emails, Scheduled Emails, SMTP, General API, Email
 * Events, Automations, Webhooks, Dashboard, Website, MCP Server) in case
 * that changes.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://resend-status.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://resend-status.com",
};

const COMPONENTS: Record<string, string[] | null> = {
  "Single Email": ["resend-email", "resend-domain"],
  "Batch Emails": ["resend-email", "resend-domain"],
  "Scheduled Emails": ["resend-email"],
  SMTP: ["resend-domain"],
  "Broadcast Emails": ["resend-broadcast", "resend-segment", "resend-contact"],
  "Email Events": ["resend-email", "resend-webhook"],
  Webhooks: ["resend-webhook"],
  Automations: ["resend-automation"],
  Dashboard: null,
  Website: null,
  "MCP Server": null,
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (trimmed === "General API") return { services: [trimmed], providerWide: true };
  const resourceTypes = COMPONENTS[trimmed];
  if (!resourceTypes) return null;
  return { services: [trimmed], resourceTypes };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((incident) => incident.state !== "resolved" && !incident.resolvedAt);
}
