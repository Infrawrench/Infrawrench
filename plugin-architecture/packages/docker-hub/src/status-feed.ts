/**
 * Docker's public status page (https://www.dockerstatus.com, verified
 * 2026-10). It serves a Statuspage-compatible `GET /api/v2/incidents.json`,
 * but `/incidents/unresolved.json` 404s and incidents carry **no
 * `components`**, so nothing in the feed says which product an incident hit.
 * The parser would treat every incident as provider-wide, and Docker's page
 * covers a dozen unrelated products (Desktop, Build Cloud, Scout, Offload…).
 * Incidents are therefore kept only when their title names something this
 * plugin depends on (Hub, the registry, pulls and pushes, images, tags,
 * sign-in), and are scoped to those services.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.dockerstatus.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.dockerstatus.com",
};

const RELEVANT =
  /\b(hub|registry|pull|pulls|pulling|push|pushes|pushing|image|images|tag|tags|repositor(y|ies)|login|log in|sign[- ]?in|authenticat\w*|docker\.io|rate limit\w*|organi[sz]ation|access token\w*)\b/i;

export function isRelevant(title: string): boolean {
  return RELEVANT.test(title);
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent: (name) => ({ services: [name] }),
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  })
    .filter((i) => isRelevant(i.title))
    .map((i) => ({ ...i, services: i.services.length ? i.services : ["Docker Hub"] }));
}
