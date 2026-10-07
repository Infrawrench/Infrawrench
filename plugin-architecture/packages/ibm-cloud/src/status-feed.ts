/**
 * IBM Cloud status feed: the status page's notification RSS,
 * `https://cloud.ibm.com/status/api/notifications/feed.rss` (anonymous,
 * verified 2026-10). Every item's description ends with labelled lines,
 * `Type: incident | maintenance | announcement | release | security`,
 * `Regions: us-south, eu-de`, `Resources: is.instance`, and for outages
 * `Outage Start:` / `Outage End:`. Only incidents and maintenance are
 * reported; releases and announcements are product news, not status.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { parseStatusFeedXml, stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://cloud.ibm.com/status/api/notifications/feed.rss",
  format: "rss",
  statusPageUrl: "https://cloud.ibm.com/status",
};

function labelled(text: string, label: string): string {
  const re = new RegExp(
    `${label}:\\s*([^\\n]*?)(?=\\s+(?:Type|Regions|Resources|Outage Start|Outage End|Update Time):|$)`,
    "i",
  );
  return re.exec(text)?.[1]?.trim() ?? "";
}

function stateOf(title: string, body: string, end: number | undefined): StatusIncidentState {
  if (end !== undefined && end <= Date.now()) return "resolved";
  if (/\bresolved\b|\bcompleted\b/i.test(title)) return "resolved";
  if (/monitoring/i.test(title) || /\bmonitoring\b/i.test(body.slice(0, 300))) return "monitoring";
  if (/identified|mitigat/i.test(body.slice(0, 300))) return "identified";
  return "investigating";
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const out: StatusIncident[] = [];
  for (const item of parseStatusFeedXml(body)) {
    const text = stripStatusHtml(item.description ?? "").replace(/\s+/g, " ");
    const type = labelled(text, "Type").toLowerCase().split(/\s/)[0] ?? "";
    if (type !== "incident" && type !== "maintenance") continue;
    const startRaw = labelled(text, "Outage Start");
    const endRaw = labelled(text, "Outage End");
    const start = startRaw ? Date.parse(startRaw) : NaN;
    const end = endRaw ? Date.parse(endRaw) : NaN;
    const state = stateOf(item.title, text, Number.isFinite(end) ? end : undefined);
    if (state === "resolved") continue;
    const regions = labelled(text, "Regions")
      .split(/[,\s]+/)
      .map((r) => r.trim())
      .filter((r) => /^[a-z]{2}-[a-z]+$/.test(r));
    const services = labelled(text, "Resources")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const published = item.publishedAt
      ? new Date(item.publishedAt).toISOString()
      : new Date().toISOString();
    const updateRaw = labelled(text, "Update Time");
    const updated =
      updateRaw && Number.isFinite(Date.parse(updateRaw))
        ? new Date(updateRaw).toISOString()
        : published;
    out.push({
      externalId: item.guid || item.link || item.title,
      title: item.title,
      state,
      impact: type === "maintenance" ? "maintenance" : "major",
      url: item.link || statusFeed.statusPageUrl!,
      startedAt: Number.isFinite(start) ? new Date(start).toISOString() : published,
      lastUpdateAt: updated,
      lastUpdateText: text.slice(0, 500),
      regions,
      services,
      ...(regions.length === 0 ? { providerWide: true } : {}),
    });
  }
  return out;
}
