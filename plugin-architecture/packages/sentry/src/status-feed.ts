/**
 * Sentry public status feed (Atlassian Statuspage, https://status.sentry.io;
 * verified 2026-10 against `/api/v2/components.json`).
 *
 * Regional components are named `US <thing>` / `EU <thing>` ("US Error
 * Ingestion", "EU Cron Monitoring"); the prefix becomes the region (EU data
 * lives in the `de` region) and the rest the service, so an EU-only incident
 * does not flag US organizations. Cron and uptime monitoring map onto their
 * resource types. The API and the dashboard escalate to provider-wide, since
 * every listing and usage figure depends on them. Third-party notification
 * channels (Slack, PagerDuty, Stripe, GitHub, sign-in providers) are ignored:
 * they say nothing about an organization's own data.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.sentry.io/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.sentry.io",
};

const PROVIDER_WIDE = new Set(["API", "Dashboard"]);
const IGNORED = new Set([
  "Slack",
  "Email",
  "PagerDuty",
  "Microsoft Teams",
  "GitHub",
  "Azure DevOps",
  "Stripe",
  "Password-Based",
  "Google",
  "SAML-Based Single Sign-On",
  "Authentication Services",
  "Notification Delivery",
  "Third-Party Integrations",
  "Integration Pipeline",
]);

const REGION_PREFIX: Record<string, string> = { US: "us", EU: "de" };

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (!trimmed || IGNORED.has(trimmed)) return null;
  if (PROVIDER_WIDE.has(trimmed)) return { services: [trimmed], providerWide: true };
  const match = /^(US|EU) (.+)$/.exec(trimmed);
  const region = match ? REGION_PREFIX[match[1]!] : undefined;
  const service = match ? match[2]! : trimmed;
  const resourceTypes = /Cron Monitoring/.test(service)
    ? ["cron-monitor"]
    : /Uptime Monitoring/.test(service)
      ? ["uptime-monitor"]
      : /Alerting/.test(service)
        ? ["alert", "monitor"]
        : undefined;
  return {
    services: [service],
    ...(region ? { regions: [region] } : {}),
    ...(resourceTypes ? { resourceTypes } : {}),
  };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
