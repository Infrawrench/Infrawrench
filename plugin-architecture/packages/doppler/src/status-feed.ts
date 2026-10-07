/**
 * Doppler's public status page (Atlassian Statuspage at
 * https://www.dopplerstatus.com, verified 2026-10). Components: the API and
 * Dashboard (everything depends on them), an "Integrations" group of sync and
 * rotation targets (Vercel, AWS Secrets Manager, GitHub…), a "Vendors" group
 * of Doppler's own suppliers, and the marketing site.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.doppler.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.dopplerstatus.com",
};

const INTEGRATION_TYPES = ["doppler-integration", "doppler-sync"];

/** Leaf names of the "Integrations" group on the page. */
const INTEGRATIONS = new Set([
  "Vercel",
  "Heroku",
  "AWS Parameter Store",
  "AWS Secrets Manager",
  "Azure App Service",
  "Azure Key Vault",
  "Azure Dev Ops",
  "CircleCI",
  "Codefresh",
  "Fly.io",
  "GCP Secret Manager",
  "GitHub",
  "Laravel Forge",
  "Netlify",
  "Railway",
  "Render",
  "AWS IAM Dynamic Secrets",
  "AWS MySQL Rotation",
  "AWS User Key Rotation",
  "SendGrid Rotation",
  "Twilio Rotation",
  "Splunk",
  "Integrations",
]);

export function mapComponent(name: string): StatusComponentMapping | null {
  if (/^API\b/.test(name) || /^Dashboard\b/.test(name))
    return { services: [name], providerWide: true };
  if (INTEGRATIONS.has(name)) return { services: [name], resourceTypes: INTEGRATION_TYPES };
  // Cloudflare fronts the API; its incidents can matter without being Doppler's own.
  if (/^Cloudflare/.test(name)) return { services: [name] };
  // Billing, docs, email and marketing suppliers never affect secrets.
  return null;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
