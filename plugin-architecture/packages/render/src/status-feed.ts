/**
 * Render public status feed (Atlassian Statuspage, https://status.render.com,
 * verified 2026-10).
 *
 * Per-region components ("Web Services", "PostgreSQL", "Builds and Deploys",
 * …) sit under one component group per region (Oregon, Ohio, Virginia,
 * Frankfurt, Singapore) and share their names across regions, so the bare
 * name says nothing about where an incident is. Incidents do carry each
 * component's `group_id`, though, and the group ids are fixed, so the body is
 * rewritten to `"<region>: <component>"` before the shared Statuspage parser
 * sees it. The region is the lowercase group name, which is exactly the
 * `region` value Render resources carry.
 *
 * Ungrouped components are global: the dashboard and both APIs are
 * provider-wide, static sites, custom domains and one-off jobs are scoped to
 * their resource types, and the marketing site is ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.render.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.render.com",
};

/** Component group id → Render region (from `/api/v2/components.json`). */
export const REGION_GROUPS: Record<string, string> = {
  "4r7rv784cclm": "oregon",
  wtb4wdj1f07v: "frankfurt",
  kvx5yy599tcf: "ohio",
  p33qq70rxmjr: "singapore",
  zzg2x8rs797p: "virginia",
};

const REGIONAL_TYPES: Record<string, string[]> = {
  "Web Services": ["service"],
  "Web Services - Free Tier": ["service"],
  "Cron Jobs": ["service"],
  "Background Workers": ["service"],
  "Builds and Deploys": ["service", "deploy"],
  Autoscaling: ["service"],
  PostgreSQL: ["postgres"],
  Redis: ["key-value"],
  "Key Value": ["key-value"],
};

const GLOBAL_TYPES: Record<string, string[]> = {
  "Static Sites": ["service"],
  "Custom Domains": ["custom-domain"],
  "One-Off Jobs": ["job"],
};

const PROVIDER_WIDE = new Set(["Render Dashboard", "Render Platform API", "Render REST API"]);

export function mapComponent(name: string): StatusComponentMapping | null {
  const regional = /^([a-z]+): (.+)$/.exec(name);
  if (regional) {
    const [, region, component] = regional as unknown as [string, string, string];
    const types = REGIONAL_TYPES[component];
    return {
      regions: [region],
      services: [component],
      ...(types ? { resourceTypes: types } : {}),
    };
  }
  if (PROVIDER_WIDE.has(name)) return { services: [name], providerWide: true };
  const types = GLOBAL_TYPES[name];
  if (types) return { services: [name], resourceTypes: types };
  if (name === "Render Website") return null;
  return { services: [name] };
}

interface FeedComponent {
  name?: string;
  group_id?: string | null;
}

/** Prefix grouped component names with their region. */
export function regionalizeBody(body: string): string {
  const parsed = JSON.parse(body) as { incidents?: Array<{ components?: FeedComponent[] }> };
  for (const incident of parsed.incidents ?? []) {
    for (const c of incident.components ?? []) {
      const region = c.group_id ? REGION_GROUPS[c.group_id] : undefined;
      if (region && c.name) c.name = `${region}: ${c.name}`;
    }
  }
  return JSON.stringify(parsed);
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(regionalizeBody(body), {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
