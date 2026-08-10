/**
 * Cloudflare public status feed (Atlassian Statuspage,
 * https://www.cloudflarestatus.com — verified 2026-08).
 *
 * Components are mostly edge PoPs named "Amsterdam, Netherlands - (AMS)"
 * (471 of them, grouped by continent) plus product/service components
 * ("Workers", "R2", "Access", "API", …). Cloudflare resources are global —
 * they carry no region field — so PoP components map to display-only
 * services, product components map to resource types, and control-plane
 * components escalate to provider-wide.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.cloudflarestatus.com",
};

/** "Amsterdam, Netherlands - (AMS)" → edge PoP AMS. */
const POP_COMPONENT = /- \(([A-Z]{3})\)$/;

const PRODUCT_TYPES: Record<string, string[]> = {
  Workers: ["worker", "worker-route", "durable-object-namespace"],
  "Workers KV": ["kv-namespace", "kv-binding"],
  R2: ["r2-bucket", "r2-s3-credentials"],
  D1: ["d1-database", "d1-binding"],
  Queues: ["queue", "queue-binding"],
  Hyperdrive: ["hyperdrive", "hyperdrive-connection"],
  Vectorize: ["vectorize-index"],
  "Workers AI": ["workers-ai-model"],
  "AI Gateway": ["ai-gateway"],
  Access: ["access-application", "access-policy"],
  "Cloudflare Access": ["access-application", "access-policy"],
  Tunnel: ["tunnel", "tunnel-token"],
  "Cloudflare Tunnel": ["tunnel", "tunnel-token"],
  DNS: ["zone", "dns-record"],
  "Authoritative DNS": ["zone", "dns-record"],
  "Load Balancing": ["load-balancer"],
  "SSL Certificate Provisioning": ["ssl-certificate", "custom-hostname"],
  Turnstile: ["turnstile-widget", "turnstile-keys"],
  "Waiting Room": ["waiting-room"],
  Spectrum: ["spectrum-application"],
  Logpush: ["logpush-job"],
  Firewall: ["firewall-rule", "rate-limit-rule", "ip-access-rule"],
  WAF: ["firewall-rule", "rate-limit-rule"],
  "Email Routing": ["email-routing-rule"],
};

function mapComponent(name: string): StatusComponentMapping | null {
  const pop = name.match(POP_COMPONENT);
  if (pop?.[1]) {
    // Edge PoP reroutes are routine and affect no stored resource — keep the
    // incident visible but scoped to a display-only service.
    return { services: [`Edge (${pop[1]})`] };
  }
  const types = PRODUCT_TYPES[name];
  if (types) return { services: [name], resourceTypes: types };
  if (name === "API" || name === "Cloudflare API" || name === "Cloudflare Sites and Services") {
    return { services: [name], providerWide: true };
  }
  if (name === "Cloudflare Dashboard" || name === "Support Site" || name === "Community Site") {
    return null;
  }
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
