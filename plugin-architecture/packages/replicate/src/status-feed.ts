/**
 * Replicate's status lives on Cloudflare's status page (Atlassian Statuspage,
 * https://www.cloudflarestatus.com) since Cloudflare acquired Replicate:
 * www.replicatestatus.com now redirects there (verified 2026-10-12).
 *
 * Replicate is one component of that page, "Replicate" (id `fvgfcmy66tdr`,
 * in the "Cloudflare Sites and Services" group), and its incidents are tagged
 * with it. The feed is Cloudflare's unresolved incidents, so the parser keeps
 * only those tagged Replicate; the rest are Cloudflare's own, which the
 * Cloudflare plugin reports. Matched by id, with the name as a fallback in
 * case the component is ever recreated.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  // Redirects to Cloudflare's page already filtered to Replicate.
  statusPageUrl: "https://www.replicatestatus.com",
};

const REPLICATE_COMPONENT_ID = "fvgfcmy66tdr";
const REPLICATE_COMPONENT_NAME = "Replicate";

interface IncidentWithComponents {
  components?: { id?: string; name?: string }[];
}

function isReplicate(component: { id?: string; name?: string }): boolean {
  return component.id === REPLICATE_COMPONENT_ID || component.name === REPLICATE_COMPONENT_NAME;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as { incidents?: IncidentWithComponents[] };
  if (!Array.isArray(parsed.incidents)) {
    throw new Error("statuspage feed: missing incidents array");
  }
  // Keep Replicate's incidents, with only the Replicate component (under its
  // canonical name), so Cloudflare components tagged alongside it don't show
  // up as Replicate services.
  const replicate = parsed.incidents
    .filter((incident) => (incident?.components ?? []).some(isReplicate))
    .map((incident) => ({ ...incident, components: [{ name: REPLICATE_COMPONENT_NAME }] }));
  // A Replicate incident is about the whole service: every prediction,
  // deployment and model goes through the same API.
  return parseStatuspageIncidents(JSON.stringify({ incidents: replicate }), {
    mapComponent: (name) => ({ services: [name], providerWide: true }),
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}
