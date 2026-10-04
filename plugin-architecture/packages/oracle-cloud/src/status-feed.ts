/**
 * OCI public status feed: the incident history RSS at
 * https://ocistatus.oraclecloud.com/history.rss (verified 2026-10). Each item
 * is one incident, titled "<service> | <region display name> | <reference>",
 * e.g. "Oracle Cloud Infrastructure Virtual Cloud Network (VCN) | US East
 * (Ashburn) | 210f910e". The description holds every update newest-first,
 * each opening with a bold state ("Resolved", "Identified", "Investigating",
 * "Monitoring"), so the first state word is the incident's current state.
 *
 * The region display name maps back to the region id the listers store via
 * `regionIdForLabel`; an incident naming no known region is provider-wide.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";
import { regionIdForLabel } from "./regions.js";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://ocistatus.oraclecloud.com/history.rss",
  format: "rss",
  statusPageUrl: "https://ocistatus.oraclecloud.com",
};

const STATES: Array<[RegExp, StatusIncidentState]> = [
  [/^\s*Resolved\b/i, "resolved"],
  [/^\s*Monitoring\b/i, "monitoring"],
  [/^\s*Identified\b/i, "identified"],
  [/^\s*Investigating\b/i, "investigating"],
];

function currentState(description: string): StatusIncidentState {
  // Updates start "Mar 05 05:12 UTC Resolved - …" once HTML is stripped.
  const m =
    /UTC\s+(Resolved|Monitoring|Identified|Investigating|Update|Scheduled|In progress|Completed)\b/i.exec(
      description,
    );
  const word = m?.[1] ?? description;
  if (/^completed$/i.test(word)) return "resolved";
  for (const [re, state] of STATES) if (re.test(word)) return state;
  return "investigating";
}

/** Customer-impact incidents are major unless OCI calls it maintenance. */
function impactOf(title: string, description: string): StatusIncident["impact"] {
  if (/maintenance/i.test(title) || /scheduled/i.test(description.slice(0, 200)))
    return "maintenance";
  return "major";
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const out: StatusIncident[] = [];
  for (const item of parseStatusFeedXml(body)) {
    const description = item.description ?? "";
    const state = currentState(description);
    if (state === "resolved") continue;
    const parts = item.title.split("|").map((p) => p.trim());
    const service = parts[0] ?? item.title;
    const regionLabel = parts.length >= 3 ? parts[1]! : "";
    const region = regionLabel ? regionIdForLabel(regionLabel) : undefined;
    const startedAt = item.publishedAt
      ? new Date(item.publishedAt).toISOString()
      : new Date().toISOString();
    out.push({
      // The guid is the incident's OCID, stable across updates.
      externalId: item.guid,
      title: item.title,
      state,
      impact: impactOf(item.title, description),
      ...(item.link ? { url: item.link } : { url: statusFeed.statusPageUrl! }),
      startedAt,
      lastUpdateAt: startedAt,
      lastUpdateText: description.slice(0, 500),
      regions: region ? [region] : [],
      services: service ? [service] : [],
      ...(region ? {} : { providerWide: true }),
    });
  }
  return out;
}
