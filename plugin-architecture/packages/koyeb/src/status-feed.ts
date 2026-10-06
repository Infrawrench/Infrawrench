/**
 * Koyeb public status page (https://status.koyeb.com, an Instatus page;
 * verified 2026-10). Instatus publishes no Statuspage incident JSON, so the
 * plugin reads `/history.rss`: one `<item>` per incident or maintenance,
 * whose description carries
 *
 *   Type: Incident | Maintenance
 *   Affected Components: Washington, D.C. - WAS, API
 *   Sep 29, 13:16:01 GMT+0 - Identified - … Sep 29, 13:45:00 GMT+0 - Resolved - …
 *
 * The updates are not always in time order, so the newest timestamp gives
 * the current state. Region components end in the region code ("Paris -
 * PAR"), which lowercased is the Koyeb region id; the continent groups
 * expand to their regions. API, Control Panel and Build / Provisioning are
 * provider-wide; third-party upstreams are display-only.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { parseStatusFeedXml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.koyeb.com/history.rss",
  format: "rss",
  statusPageUrl: "https://status.koyeb.com",
};

const MAX_RESOLVED_AGE_MS = 3 * 24 * 3_600_000;

const CONTINENTS: Record<string, string[]> = {
  "north america": ["was", "sfo"],
  europe: ["fra", "par"],
  "asia–pacific - apac": ["sin", "tyo"],
  "asia-pacific - apac": ["sin", "tyo"],
};
const PROVIDER_WIDE = new Set(["api", "control panel", "build / provisioning"]);
const REGION = /\s-\s([A-Z]{3})$/;

function stateOf(word: string): StatusIncidentState {
  const w = word.toLowerCase();
  if (w.startsWith("resolved") || w.startsWith("completed")) return "resolved";
  if (w.startsWith("monitoring")) return "monitoring";
  if (w.startsWith("identified")) return "identified";
  return "investigating";
}

/** "Sep 29, 13:16:01" has no year: take the item's year, rolling over at New Year. */
function markerDate(raw: string, start: Date): Date {
  const year = start.getUTCFullYear();
  let d = new Date(`${raw.replace(",", ` ${year}`)} UTC`);
  if (Number.isNaN(d.getTime())) return start;
  if (d.getTime() < start.getTime() - 86_400_000)
    d = new Date(`${raw.replace(",", ` ${year + 1}`)} UTC`);
  return d;
}

export function parseStatusFeed(body: string, now: number = Date.now()): StatusIncident[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) {
    throw new Error("Koyeb status feed: not an RSS document");
  }
  const out: StatusIncident[] = [];
  for (const item of parseStatusFeedXml(body)) {
    const text = (item.description ?? "").replace(/\s+/g, " ");
    const startedAt = item.publishedAt ? new Date(item.publishedAt) : null;
    if (!startedAt || Number.isNaN(startedAt.getTime())) continue;
    const isMaintenance = /Type:\s*Maintenance/i.test(text);
    const markers = [
      ...text.matchAll(
        /([A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}:\d{2}) GMT\+0 - ([A-Za-z ]+?) - (.*?)(?=[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}:\d{2} GMT\+0 - |$)/g,
      ),
    ].map((m) => ({ at: markerDate(m[1]!, startedAt), state: m[2]!, text: m[3]!.trim() }));
    markers.sort((a, b) => a.at.getTime() - b.at.getTime());
    const last = markers[markers.length - 1];
    const state = last ? stateOf(last.state) : "investigating";
    const lastAt = last?.at ?? startedAt;
    if (state === "resolved" && now - lastAt.getTime() > MAX_RESOLVED_AGE_MS) continue;
    if (
      isMaintenance &&
      /scheduled|not ?started/i.test(last?.state ?? "") &&
      startedAt.getTime() > now
    )
      continue;
    const components = (
      /Affected Components:\s*(.*?)(?=\s[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}:\d{2} GMT|$)/i.exec(
        text,
      )?.[1] ?? ""
    )
      // "Washington, D.C. - WAS" carries its own comma.
      .replace(/Washington, D\.C\./g, "Washington D.C.")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const regions = new Set<string>();
    const services: string[] = [];
    let providerWide = components.length === 0;
    for (const c of components) {
      const key = c.toLowerCase();
      const code = REGION.exec(c)?.[1];
      if (code) regions.add(code.toLowerCase());
      for (const r of CONTINENTS[key] ?? []) regions.add(r);
      if (PROVIDER_WIDE.has(key)) providerWide = true;
      services.push(c);
    }
    const thirdPartyOnly =
      components.length > 0 && components.every((c) => /^Third Party:/i.test(c));
    if (thirdPartyOnly) providerWide = false;
    const impact: StatusIncidentImpact = isMaintenance
      ? "maintenance"
      : providerWide
        ? "major"
        : "minor";
    out.push({
      externalId: item.guid,
      title: item.title,
      state,
      impact,
      ...(item.link ? { url: item.link } : {}),
      startedAt: startedAt.toISOString(),
      ...(state === "resolved" ? { resolvedAt: lastAt.toISOString() } : {}),
      lastUpdateAt: lastAt.toISOString(),
      ...(last?.text ? { lastUpdateText: last.text } : {}),
      regions: [...regions],
      services,
      ...(regions.size ? { resourceTypes: ["service", "instance", "volume"] } : {}),
      ...(providerWide ? { providerWide: true } : {}),
    });
  }
  return out;
}
