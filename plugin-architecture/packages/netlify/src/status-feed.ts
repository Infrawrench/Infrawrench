/**
 * Netlify public status feed (Atlassian Statuspage,
 * https://www.netlifystatus.com — verified 2026-08).
 *
 * Components on this page are services and upstreams only — there are no
 * region components ("High-Performance Edge Network", "Build Pipeline",
 * "GitHub API Requests", "NS1 API", …). Netlify-owned core components
 * escalate to provider-wide since Netlify resources are global; upstream
 * components (GitHub, GitLab, Bitbucket, NS1, AWS) and Community/Support
 * never affect infrastructure this plugin manages and are ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.netlifystatus.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.netlifystatus.com",
};

/** Netlify-owned core platform components — an incident here hits everything. */
const CORE_COMPONENTS = new Set([
  "High-Performance Edge Network",
  "Build Pipeline",
  "Continuous Deployment",
  "Netlify DNS",
  "API",
  "Functions",
  "Edge Functions",
  "Forms",
]);

/** Upstream/third-party components and non-infrastructure surfaces. */
const IGNORED = /GitHub|GitLab|Bitbucket|NS1|AWS|Community|Support/i;

function mapComponent(name: string): StatusComponentMapping | null {
  if (CORE_COMPONENTS.has(name)) return { services: [name], providerWide: true };
  if (IGNORED.test(name)) return null;
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
