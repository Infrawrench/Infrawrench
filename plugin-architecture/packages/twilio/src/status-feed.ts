/**
 * Twilio public status feed (Atlassian Statuspage, https://status.twilio.com:
 * verified 2026-10).
 *
 * Components are product features ("SMS Long Code, North America",
 * "Verify", "Lookup") and per-region voice infrastructure ("PSTN US1",
 * "Conference IE1"). Account-wide surfaces (REST API, Billing, Console)
 * escalate to provider-wide. SendGrid and Zipwhip share the page but are
 * separate products this plugin does not manage, and documentation or
 * support components never affect an account, so those are ignored.
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

const PROVIDER_WIDE = new Set(["REST API", "API v2", "API v3", "Billing", "Console"]);

const IGNORED =
  /sendgrid|zipwhip|mailsend|smtp|documentation|support|dedicated ip|parse api|event webhooks/i;

export function mapComponent(name: string): StatusComponentMapping | null {
  if (IGNORED.test(name)) return null;
  if (PROVIDER_WIDE.has(name)) return { services: [name], providerWide: true };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
