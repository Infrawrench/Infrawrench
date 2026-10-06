/**
 * Stripe public status feed.
 *
 * `status.stripe.com` is Stripe's own page and its JSON (`/current`) has been
 * frozen since February 2024. The live incident feed is the Atlassian
 * Statuspage at https://www.stripestatus.com (page id `d5zv7xbys5v3`,
 * verified 2026-10-06), whose `/api/v2/incidents/unresolved.json` is used here.
 *
 * Its six top-level components (no groups) are broad product areas:
 * "Stripe API" (provider-wide: every listing goes through it), "Global
 * payments", "Revenue and finance automation" (Billing, Invoicing, Tax,
 * reporting and Sigma), "Banking-as-a-service" (Treasury, Issuing, Capital),
 * "Stripe core components" (Dashboard, webhooks, Connect) and "Acquirers and
 * payment methods" (third-party networks such as Swish, which only matter
 * through the payments they degrade).
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";
import {
  ACCOUNT,
  CONNECTED_ACCOUNT,
  EVENT_DESTINATION,
  METER,
  PAYOUT,
  PRICE,
  PRODUCT,
  REPORT_RUN,
  SIGMA_RUN,
  WEBHOOK_ENDPOINT,
} from "./resource-types.js";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.stripestatus.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.stripestatus.com",
};

const COMPONENTS: Record<string, string[] | null> = {
  "Global payments": [ACCOUNT, PAYOUT],
  "Revenue and finance automation": [PRODUCT, PRICE, METER, REPORT_RUN, SIGMA_RUN],
  "Stripe core components": [ACCOUNT, CONNECTED_ACCOUNT, WEBHOOK_ENDPOINT, EVENT_DESTINATION],
  "Banking-as-a-service": null,
  "Acquirers and payment methods": null,
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (trimmed === "Stripe API") return { services: [trimmed], providerWide: true };
  const resourceTypes = COMPONENTS[trimmed];
  if (!resourceTypes) return null;
  return { services: [trimmed], resourceTypes };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
