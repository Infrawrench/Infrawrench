/**
 * Auth0 public status feed (https://status.auth0.com, verified 2026-10).
 *
 * The status site is Auth0's own (not Statuspage): `/api/v2/*` 404s. It
 * publishes an Atom feed per tenant environment at
 * `/feed?domain=<tenant domain>`, and different public-cloud environments
 * answer different incident lists. The host polls one static URL, so this
 * reads the feed for the original US public environment and tags its
 * incidents with region "us"; tenants record their region from their domain
 * (`{tenant}.{us|eu|au|jp|…}.auth0.com`, bare `.auth0.com` = us), so the
 * correlation stays to US tenants rather than alarming every account.
 *
 * Each entry's <content> is the update history newest first, each update
 * starting `<strong>{Status}</strong> - text`; the newest status decides the
 * state ("Postmortem" and "Resolved" both mean over).
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.auth0.com/feed?domain=samples.auth0.com",
  format: "atom",
  statusPageUrl: "https://status.auth0.com",
};

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  const inner = (match?.[1] ?? "").trim();
  return (inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)?.[1] ?? inner).trim();
}

function stateOf(status: string): StatusIncidentState | "resolved-final" {
  const s = status.toLowerCase();
  if (s.startsWith("resolved") || s.startsWith("postmortem") || s.startsWith("completed"))
    return "resolved-final";
  if (s.startsWith("monitoring")) return "monitoring";
  if (s.startsWith("identified")) return "identified";
  return "investigating";
}

export function parseStatusFeed(body: string): StatusIncident[] {
  if (!/<feed/i.test(body)) throw new Error("auth0 status feed: not an Atom document");
  const out: StatusIncident[] = [];
  for (const block of body.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? []) {
    const id = tag(block, "id");
    const title = stripStatusHtml(tag(block, "title"));
    if (!id || !title) continue;
    const html = tag(block, "content") || tag(block, "summary");
    const latest = html.match(/<strong>([^<]+)<\/strong>\s*-\s*([\s\S]*?)<\/p>/i);
    const state = stateOf(latest?.[1] ?? "investigating");
    if (state === "resolved-final") continue;
    const link = block.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    const updated = tag(block, "updated");
    out.push({
      externalId: id,
      title,
      state,
      impact: /maintenance/i.test(title)
        ? "maintenance"
        : /outage|disruption|unavailable/i.test(title)
          ? "major"
          : "minor",
      ...(link ? { url: link } : {}),
      startedAt: updated || new Date(0).toISOString(),
      ...(updated ? { lastUpdateAt: updated } : {}),
      ...(latest?.[2] ? { lastUpdateText: stripStatusHtml(latest[2]) } : {}),
      regions: ["us"],
      services: [],
    });
  }
  return out;
}
