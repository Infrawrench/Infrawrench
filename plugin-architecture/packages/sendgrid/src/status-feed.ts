/**
 * SendGrid's status page is part of Twilio's (status.sendgrid.com redirects
 * to status.twilio.com, Atlassian Statuspage, verified 2026-10). SendGrid has
 * its own component groups there ("SendGrid Mail Sending", "SendGrid Webhooks",
 * "SendGrid API", "SendGrid Statistics", ...), whose children are named
 * "API v3", "SMTP", "Event Webhooks", "Parse API" and so on.
 *
 * The page also carries every Twilio product, so incidents are filtered to
 * SendGrid ones first: an incident is kept only when it names a SendGrid
 * component or "SendGrid" in its title. The rest is the shared Statuspage
 * parser with a SendGrid component mapper.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.twilio.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.twilio.com",
};

/** Child components under SendGrid groups, and what they affect. */
const CHILDREN: Record<string, StatusComponentMapping> = {
  SMTP: { services: ["Mail sending (SMTP)"], providerWide: true },
  "API v2": { services: ["SendGrid API v2"], providerWide: true },
  "API v3": { services: ["SendGrid API v3"], providerWide: true },
  "Event Webhooks": { services: ["Event Webhooks"], resourceTypes: ["sendgrid-event-webhook"] },
  "Parse API": { services: ["Inbound Parse"], resourceTypes: ["sendgrid-inbound-parse"] },
  "Dedicated IP Address": { services: ["Dedicated IPs"], resourceTypes: ["sendgrid-ip"] },
};

function isSendGridComponent(name: string): boolean {
  return /^sendgrid\b/i.test(name) || name in CHILDREN;
}

export function mapComponent(name: string): StatusComponentMapping | null {
  const child = CHILDREN[name];
  if (child) return child;
  if (!/^sendgrid\b/i.test(name)) return null;
  if (/mail sending|api$/i.test(name)) return { services: [name], providerWide: true };
  if (/webhooks/i.test(name)) {
    return {
      services: [name],
      resourceTypes: ["sendgrid-event-webhook", "sendgrid-inbound-parse"],
    };
  }
  // Website, Statistics, Email Activity, Billing, Marketing Campaigns, Partners.
  return { services: [name], resourceTypes: ["sendgrid-account"] };
}

interface Incident {
  name?: string;
  components?: Array<{ name?: string }>;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as { incidents?: Incident[] };
  if (!parsed || !Array.isArray(parsed.incidents)) {
    throw new Error("SendGrid status feed: expected a Statuspage incidents document");
  }
  const incidents = parsed.incidents.filter(
    (i) =>
      (i.components ?? []).some((c) => isSendGridComponent(c.name ?? "")) ||
      /sendgrid/i.test(i.name ?? ""),
  );
  return parseStatuspageIncidents(JSON.stringify({ ...parsed, incidents }), {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
