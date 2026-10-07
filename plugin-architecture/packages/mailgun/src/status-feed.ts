/**
 * Mailgun public status feed (Atlassian Statuspage, https://status.mailgun.com,
 * verified 2026-10). Components are services, not regions: "API", "SMTP",
 * "Outbound Delivery", "Inbound email processing", "Events & Logs", "Stats and
 * Analytics" under Email Services, a "Control Panel", and the deliverability
 * tools (Email Validation, Inbox Placement, Spam Trap Network, Email
 * Previews), which this plugin does not manage and so ignores.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.mailgun.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.mailgun.com",
};

const MAP: Record<string, StatusComponentMapping> = {
  API: { services: ["API"], providerWide: true },
  SMTP: { services: ["SMTP"], providerWide: true },
  "Outbound Delivery": { services: ["Outbound Delivery"], providerWide: true },
  "Email Services": { services: ["Email Services"], providerWide: true },
  "Inbound email processing": {
    services: ["Inbound email processing"],
    resourceTypes: ["mailgun-route", "mailgun-mailing-list"],
  },
  "Events & Logs": {
    services: ["Events & Logs"],
    resourceTypes: ["mailgun-webhook", "mailgun-account-webhook"],
  },
  "Stats and Analytics": {
    services: ["Stats and Analytics"],
    resourceTypes: ["mailgun-account", "mailgun-domain", "mailgun-tag"],
  },
  "Control Panel": { services: ["Control Panel"], resourceTypes: ["mailgun-account"] },
};

export function mapComponent(name: string): StatusComponentMapping | null {
  return MAP[name] ?? null;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
