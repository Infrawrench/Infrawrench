/**
 * Postmark's public status page (status.postmarkapp.com) runs on Sorry™, not
 * Statuspage: the Statuspage `/api/v2/*` paths 404. Its documented status API
 * is `GET /api/v1/notices` (verified 2026-10): newest first, each notice
 * `{ id, type: general|planned|unplanned, state, timeline_state, subject,
 * url, began_at, ended_at, updated_at, latest_update: { content } }`.
 *
 * Notices name no components or regions, and every Postmark resource sits on
 * the same platform, so each active notice is provider-wide.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.postmarkapp.com/api/v1/notices",
  format: "custom-json",
  statusPageUrl: "https://status.postmarkapp.com",
};

interface SorryNotice {
  id?: number | string;
  type?: string;
  state?: string;
  timeline_state?: string;
  subject?: string;
  url?: string;
  began_at?: string | null;
  ended_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  latest_update?: { content?: string | null; created_at?: string | null } | null;
}

const UNPLANNED_STATE: Record<string, StatusIncidentState> = {
  investigating: "investigating",
  identified: "identified",
  recovering: "monitoring",
  resolved: "resolved",
  false_alarm: "resolved",
};

/** A notice is reported while it is happening, or ended recently (so the host can close it). */
function isReported(n: SorryNotice): boolean {
  const timeline = n.timeline_state ?? "";
  if (n.type === "planned") return n.state === "underway" || timeline === "present";
  if (n.type === "unplanned") return timeline === "present" || timeline === "past_recent";
  return timeline === "present";
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as { notices?: SorryNotice[] };
  if (!parsed || !Array.isArray(parsed.notices)) {
    throw new Error("Postmark status feed: expected a { notices: [...] } document");
  }
  const out: StatusIncident[] = [];
  for (const n of parsed.notices) {
    if (n.id === undefined || !isReported(n)) continue;
    const planned = n.type === "planned";
    const state: StatusIncidentState = planned
      ? n.state === "complete" || n.state === "cancelled"
        ? "resolved"
        : "monitoring"
      : (UNPLANNED_STATE[n.state ?? ""] ?? "investigating");
    const startedAt = n.began_at ?? n.created_at ?? n.updated_at ?? new Date(0).toISOString();
    const text = n.latest_update?.content ? stripStatusHtml(n.latest_update.content).trim() : "";
    out.push({
      externalId: String(n.id),
      title: n.subject ?? "Postmark notice",
      state,
      impact: planned ? "maintenance" : "major",
      ...(n.url ? { url: n.url } : {}),
      startedAt,
      ...(state === "resolved" && n.ended_at ? { resolvedAt: n.ended_at } : {}),
      ...(n.updated_at ? { lastUpdateAt: n.updated_at } : {}),
      ...(text ? { lastUpdateText: text.slice(0, 2000) } : {}),
      regions: [],
      services: ["Postmark"],
      providerWide: true,
    });
  }
  return out;
}
