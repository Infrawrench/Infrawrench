/**
 * Algolia status, from the public half of the Monitoring API
 * (`GET https://status.algolia.com/1/incidents`, no key needed, verified
 * 2026-10). The body is `{incidents: {<cluster>: [{t, v: {title, status}}]}}`
 * with `status` one of `operational`, `degraded_performance`,
 * `partial_outage`, `major_outage`; a cluster's newest entry is its current
 * state. Algolia has no Statuspage incidents feed (algolia.statuspage.io is
 * inactive).
 *
 * Clusters (`c16-de`, `m81-usc`) are the plugin's region ids: the
 * application's `region` field lists the clusters its servers belong to when
 * a Monitoring API key is present.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
} from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.algolia.com/1/incidents",
  format: "custom-json",
  statusPageUrl: "https://status.algolia.com",
};

/** Resolved incidents older than this are dropped. */
const RESOLVED_WINDOW_MS = 3 * 86_400_000;

interface Entry {
  t?: number;
  v?: { title?: string; status?: string };
}

function impactOf(status: string): StatusIncidentImpact {
  if (status === "major_outage") return "major";
  if (status === "partial_outage" || status === "degraded_performance") return "minor";
  return "minor";
}

export function parseStatusFeed(body: string, now = Date.now()): StatusIncident[] {
  const doc = JSON.parse(body) as { incidents?: Record<string, Entry[]> };
  if (!doc || typeof doc.incidents !== "object" || doc.incidents === null) {
    throw new Error("Algolia status feed: no `incidents` object");
  }
  const out: StatusIncident[] = [];
  for (const [cluster, raw] of Object.entries(doc.incidents)) {
    const entries = (raw ?? []).filter((e) => typeof e.t === "number").sort((a, b) => a.t! - b.t!);
    if (!entries.length) continue;
    // Walk forward grouping each run of non-operational entries into one incident.
    let start: Entry | undefined;
    let last: Entry | undefined;
    const flush = (resolvedBy?: Entry) => {
      if (!start || !last) return;
      const resolved = !!resolvedBy;
      const endT = resolvedBy?.t;
      if (resolved && endT !== undefined && now - endT > RESOLVED_WINDOW_MS) return;
      const worst = [start, last].some((e) => e.v?.status === "major_outage")
        ? "major_outage"
        : (last.v?.status ?? "");
      out.push({
        externalId: `${cluster}-${start.t}`,
        title: (start.v?.title ?? `Incident on cluster ${cluster}`).trim(),
        state: resolved ? "resolved" : "investigating",
        impact: impactOf(worst),
        url: statusFeed.statusPageUrl ?? statusFeed.url,
        startedAt: new Date(start.t!).toISOString(),
        ...(resolved && endT !== undefined ? { resolvedAt: new Date(endT).toISOString() } : {}),
        lastUpdateAt: new Date((resolvedBy ?? last).t!).toISOString(),
        lastUpdateText: ((resolvedBy ?? last).v?.title ?? "").trim(),
        regions: [cluster],
        services: ["Search API"],
      });
    };
    for (const e of entries) {
      const s = e.v?.status ?? "";
      if (s && s !== "operational") {
        start ??= e;
        last = e;
      } else if (start) {
        flush(e);
        start = undefined;
        last = undefined;
      }
    }
    flush();
  }
  return out;
}
