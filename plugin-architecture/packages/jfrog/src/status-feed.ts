/**
 * JFrog Cloud public status feed (Atlassian Statuspage at
 * https://status.jfrog.io, verified 2026-10).
 *
 * The page groups components by cloud region ("Europe - Central1 (Frankfurt)
 * - AWS"), and inside each group repeats the same product names
 * ("Artifactory", "Security - Xray", "Web UI", …). Incidents list only the
 * leaf product names, so the region an incident hit cannot be recovered from
 * the feed: incidents are scoped by product, never by region. The platform
 * this plugin connects to may also be self-hosted, which JFrog Cloud
 * incidents never touch; the docs say so.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.jfrog.io/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.jfrog.io",
};

const ARTIFACTORY_TYPES = ["jfrog-platform", "jfrog-repository", "jfrog-build", "jfrog-build-run"];
const XRAY_TYPES = ["jfrog-xray-watch", "jfrog-xray-policy", "jfrog-xray-violation"];

export function mapComponent(name: string): StatusComponentMapping | null {
  const n = name.trim();
  if (n === "Artifactory") return { services: ["Artifactory"], resourceTypes: ARTIFACTORY_TYPES };
  if (n === "Security - Xray") return { services: ["Xray"], resourceTypes: XRAY_TYPES };
  // Customer portal and the IoT product never affect a platform's resources.
  if (/MyJFrog|Customer Portal|JFrog Connect/i.test(n)) return null;
  // Web UI, Webhook, Distribution, Pipelines and the other security
  // products: real platform services, but not ones a resource type models.
  return { services: [n.replace(/^Security - /, "")] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
