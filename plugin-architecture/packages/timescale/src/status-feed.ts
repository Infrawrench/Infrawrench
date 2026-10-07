/**
 * Tiger Data service health (https://status.tigerdata.com, a Rootly status
 * page; verified 2026-10). The JSON endpoints sit behind a bot challenge, but
 * the RSS history at `/history.rss` is served plainly. One item per incident
 * or maintenance (not per update): the description opens with the current
 * state in brackets (`[Resolved]`, `[Completed]`, `[In Progress]`,
 * `[Investigating]`, …) and ends with `Impacted: <component>`. Components seen:
 * "Database - Data Plane and Core Availability", "Database - Control Plane
 * Actions (create, resize, resume, etc)", "Console & API", "Observability",
 * "Data Movement & Connectors". Maintenance notices list the affected region
 * codes in their body (`eu-central-1`, `az-eastus2`), the same codes services
 * carry in their `region` field.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";
import { REGION_IDS } from "./catalog.js";
import { T } from "./resource-types.js";

const STATUS_PAGE = "https://status.tigerdata.com";

export const statusFeed: StatusFeedDeclaration = {
  url: `${STATUS_PAGE}/history.rss`,
  format: "rss",
  statusPageUrl: STATUS_PAGE,
};

/** Finished incidents older than this are history, not news. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function stateOf(raw: string | undefined): StatusIncidentState {
  switch ((raw ?? "").toLowerCase()) {
    case "resolved":
    case "completed":
    case "postmortem":
    case "cancelled":
      return "resolved";
    case "identified":
      return "identified";
    case "monitoring":
    case "mitigated":
    case "verifying":
      return "monitoring";
    default:
      return "investigating";
  }
}

const MAINTENANCE_STATES = new Set(["scheduled", "in progress", "completed", "cancelled"]);

const REGION_PATTERN = new RegExp(
  `(?<![a-z0-9-])(${REGION_IDS.map((r) => r.replace(/-/g, "\\-")).join("|")})(?![a-z0-9-])`,
  "gi",
);

function scope(component: string): {
  resourceTypes: string[];
  services: string[];
  providerWide: boolean;
} {
  const c = component.toLowerCase();
  if (!c) return { resourceTypes: [], services: [], providerWide: true };
  if (c.includes("console") || c.includes("api")) {
    return { resourceTypes: [], services: [component], providerWide: true };
  }
  if (c.startsWith("database")) {
    return { resourceTypes: [T.service, T.replica], services: [component], providerWide: false };
  }
  return { resourceTypes: [], services: [component], providerWide: false };
}

export function parseStatusFeed(body: string, now: number = Date.now()): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) {
    throw new Error("Tiger Data status feed: not an RSS document");
  }
  const out: StatusIncident[] = [];
  for (const item of parseStatusFeedXml(body)) {
    const at = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    if (Number.isNaN(at)) continue;
    const text = item.description ?? "";
    const rawState = /^\s*\[([^\]]+)\]/.exec(text)?.[1]?.trim() ?? "";
    const state = stateOf(rawState);
    if (state === "resolved" && now - at > MAX_AGE_MS) continue;
    const component = /Impacted:\s*(.+?)\s*$/i.exec(text)?.[1]?.trim() ?? "";
    const maintenance =
      MAINTENANCE_STATES.has(rawState.toLowerCase()) || /maintenance/i.test(item.title);
    const impact: StatusIncidentImpact = maintenance ? "maintenance" : "major";
    const regions = Array.from(
      new Set((text.match(REGION_PATTERN) ?? []).map((r) => r.toLowerCase())),
    );
    const s = scope(component);
    // The console/API component, or an item naming no component and no
    // region, can affect anything. A named component other than those
    // (Observability, Data Movement) stays scoped to its service name.
    const providerWide = component ? s.providerWide : regions.length === 0;
    const lastUpdateText = text
      .replace(/^\s*\[[^\]]+\]\s*/, "")
      .slice(0, 500)
      .trim();
    out.push({
      externalId: item.guid,
      title: item.title,
      state,
      impact,
      ...(item.link ? { url: item.link } : {}),
      startedAt: new Date(at).toISOString(),
      lastUpdateAt: new Date(at).toISOString(),
      ...(state === "resolved" ? { resolvedAt: new Date(at).toISOString() } : {}),
      ...(lastUpdateText ? { lastUpdateText } : {}),
      regions,
      services: s.services,
      ...(s.resourceTypes.length ? { resourceTypes: s.resourceTypes } : {}),
      ...(providerWide ? { providerWide: true } : {}),
    });
  }
  return out;
}
