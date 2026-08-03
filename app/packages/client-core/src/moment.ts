/**
 * "What changed around 03:14?" — the moment view contract.
 *
 * Wire types for `GET /api/org/{orgId}/moment`, plus the pure merge/grouping
 * logic every surface shares (web, desktop, mobile, CLI, MCP). The server
 * unions the feeds the platform already indexes — resource changes, cost
 * anomalies, workflow runs, deployments, provider status incidents, audit
 * entries, change freezes, and the drift/expiry alert claims — into one
 * chronological list of typed events for a timestamp ± window.
 *
 * The server half lives in web `services/moment.ts`. Keeping the response
 * shape here means the two ends of the wire cannot drift apart silently,
 * same as `resource-changes.ts` and `status-incidents.ts`.
 */

import type { CloudFetch } from "./fetch";
import type { ProviderIncidentImpact } from "./status-incidents";

/** The feeds the union draws from, in canonical display order. */
export const MOMENT_FEED_IDS = [
  "changes",
  "statusIncidents",
  "costAnomalies",
  "workflowRuns",
  "deployments",
  "audit",
  "freezes",
  "driftAlerts",
  "expiryAlerts",
] as const;

export type MomentFeedId = (typeof MOMENT_FEED_IDS)[number];

/** Human names for feeds — used for "workflow runs unavailable" chips. */
export const MOMENT_FEED_LABELS: Record<MomentFeedId, string> = {
  changes: "Resource changes",
  statusIncidents: "Provider incidents",
  costAnomalies: "Cost anomalies",
  workflowRuns: "Workflow runs",
  deployments: "Deployments",
  audit: "Audit log",
  freezes: "Change freezes",
  driftAlerts: "Drift alerts",
  expiryAlerts: "Expiry alerts",
};

/**
 * Per-feed outcome for one union request. `omitted` means the caller lacks
 * the feed's read permission (reported, never errored); `error` means the
 * feed's query failed but the rest of the response is still good.
 */
export interface MomentFeedStatus {
  feed: MomentFeedId;
  status: "ok" | "omitted" | "error";
  /** Short human-readable failure reason when `status === "error"`. */
  error?: string | null;
  /** True when the feed hit its row cap and older rows were dropped. */
  truncated?: boolean;
}

export type MomentSeverity = "info" | "warning" | "critical";

/**
 * Where an event row should deep-link. Hosts map `kind` onto their native
 * screen (web route, desktop route, mobile stack push); `url` is an absolute
 * external link (a provider's incident page) and wins when present.
 */
export interface MomentEventLink {
  kind:
    | "resource"
    | "changes"
    | "incident"
    | "costs"
    | "workflow-run"
    | "deployment"
    | "audit"
    | "freeze"
    | "expiring";
  /** Target id where the kind needs one (resourceId, run id, freeze id…). */
  id?: string | null;
  /** Parent id where the target needs one (workflowId for a run). */
  parentId?: string | null;
  /** Absolute external URL — provider status pages. */
  url?: string | null;
}

/** One event in the merged window, as returned by the union endpoint. */
export interface MomentEvent {
  /** Stable synthetic id, unique within a response (`feed:rowId[:phase]`). */
  id: string;
  feed: MomentFeedId;
  /**
   * Fine-grained kind, `<noun>.<verb>` — e.g. `change.created`,
   * `change.updated`, `change.deleted`, `incident.started`,
   * `incident.resolved`, `anomaly.spike`, `anomaly.new_source`,
   * `workflow-run.started`, `workflow-run.succeeded`, `workflow-run.failed`,
   * `workflow-run.canceled`, `deployment.started`, `deployment.finished`,
   * `deployment.failed`, `audit.<action>`, `freeze.started`, `freeze.ended`,
   * `drift-alert.sent`, `expiry-alert.sent`. Open set — render unknown kinds
   * generically.
   */
  kind: string;
  /** ISO timestamp the event is plotted at. */
  timestamp: string;
  /** One-line headline, e.g. `"api-prod-1 changed (size, region)"`. */
  title: string;
  /** Optional second line — diff summary, error text, actor. */
  detail?: string | null;
  severity: MomentSeverity;
  pluginId?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  resourceId?: string | null;
  /** Needed alongside pluginId/resourceId for resource deep links. */
  resourceTypeId?: string | null;
  resourceName?: string | null;
  link?: MomentEventLink | null;
}

/**
 * A provider incident whose span overlaps the requested window — returned
 * alongside the events so hosts can badge events that fall inside it
 * ("during DigitalOcean incident").
 */
export interface MomentIncidentSpan {
  id: string;
  pluginId: string;
  pluginName: string;
  title: string;
  impact: ProviderIncidentImpact;
  startedAt: string;
  resolvedAt?: string | null;
  url?: string | null;
}

export interface MomentResponse {
  /** The centre timestamp, echoed back normalized to ISO. */
  at: string;
  /** Window bounds actually queried (`at ± windowMinutes`). */
  from: string;
  to: string;
  windowMinutes: number;
  generatedAt: string;
  feeds: MomentFeedStatus[];
  /** Chronological (oldest first). */
  events: MomentEvent[];
  incidents: MomentIncidentSpan[];
}

/* ------------------------------------------------------------------ *
 * Window handling
 * ------------------------------------------------------------------ */

/** Half-window presets offered by every surface. */
export const MOMENT_WINDOW_PRESETS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: "±15m" },
  { minutes: 60, label: "±1h" },
  { minutes: 360, label: "±6h" },
];

export const DEFAULT_MOMENT_WINDOW_MINUTES = 60;

/** Bounds the API enforces on `window` (half-width, minutes). ±3 days max. */
export const MOMENT_WINDOW_LIMITS = { min: 1, max: 4320 } as const;

/** Clamp a half-window to the limits; non-finite input gets the default. */
export function clampMomentWindow(windowMinutes: number | undefined): number {
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes)) {
    return DEFAULT_MOMENT_WINDOW_MINUTES;
  }
  return Math.min(
    MOMENT_WINDOW_LIMITS.max,
    Math.max(MOMENT_WINDOW_LIMITS.min, Math.round(windowMinutes)),
  );
}

/** `[at − window, at + window]` as Dates. Throws on an unparseable centre. */
export function momentWindowBounds(
  at: string | Date,
  windowMinutes: number,
): { from: Date; to: Date } {
  const centre = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(centre.getTime())) throw new Error(`Invalid moment timestamp: ${String(at)}`);
  const half = clampMomentWindow(windowMinutes) * 60_000;
  return { from: new Date(centre.getTime() - half), to: new Date(centre.getTime() + half) };
}

/* ------------------------------------------------------------------ *
 * Pure merge / badge / group logic
 * ------------------------------------------------------------------ */

const FEED_ORDER: Record<MomentFeedId, number> = MOMENT_FEED_IDS.reduce(
  (acc, feed, index) => {
    acc[feed] = index;
    return acc;
  },
  {} as Record<MomentFeedId, number>,
);

/**
 * Chronological comparator (oldest first), with deterministic tie-breaks by
 * feed order then id so a merged list is stable across refreshes.
 */
export function compareMomentEvents(a: MomentEvent, b: MomentEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  const feed = (FEED_ORDER[a.feed] ?? 99) - (FEED_ORDER[b.feed] ?? 99);
  if (feed !== 0) return feed;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Incident spans whose `[startedAt, resolvedAt ?? ∞]` cover `timestamp`. */
export function incidentsCovering(
  timestamp: string,
  incidents: MomentIncidentSpan[],
): MomentIncidentSpan[] {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return [];
  return incidents.filter((incident) => {
    const start = Date.parse(incident.startedAt);
    if (Number.isNaN(start) || t < start) return false;
    if (!incident.resolvedAt) return true;
    const end = Date.parse(incident.resolvedAt);
    return Number.isNaN(end) || t <= end;
  });
}

/** `"during DigitalOcean incident"` — badge text for an event inside spans. */
export function describeIncidentBadge(spans: MomentIncidentSpan[]): string | null {
  if (spans.length === 0) return null;
  const names: string[] = [];
  for (const span of spans) {
    if (!names.includes(span.pluginName)) names.push(span.pluginName);
  }
  return `during ${names.join(", ")} incident${spans.length > 1 && names.length > 1 ? "s" : ""}`;
}

/** A run of ≥ `burstMinEvents` events on one resource within tight gaps. */
export interface MomentBurst {
  kind: "burst";
  key: string;
  resourceId: string;
  resourceName: string | null;
  /** Chronological members. */
  events: MomentEvent[];
  /** Incident spans covering any member — union, for the group badge. */
  incidentIds: string[];
}

export interface MomentSingle {
  kind: "event";
  key: string;
  event: MomentEvent;
  /** Ids of incident spans covering this event's timestamp. */
  incidentIds: string[];
}

export type MomentTimelineItem = MomentSingle | MomentBurst;

export interface BuildMomentTimelineOptions {
  /** Adjacent same-resource events at most this far apart join a burst. */
  burstGapMinutes?: number;
  /** Fewest events that render as a burst rather than individually. */
  burstMinEvents?: number;
}

export const DEFAULT_BURST_GAP_MINUTES = 10;
export const DEFAULT_BURST_MIN_EVENTS = 3;

/**
 * Sort events chronologically, badge each with the incident spans covering
 * it, and collapse dense per-resource bursts (≥ `burstMinEvents` adjacent
 * events on the same resource, each within `burstGapMinutes` of the last)
 * into one group. Pure; shared by every surface that renders the timeline.
 */
export function buildMomentTimeline(
  events: MomentEvent[],
  incidents: MomentIncidentSpan[],
  options: BuildMomentTimelineOptions = {},
): MomentTimelineItem[] {
  const gapMs = (options.burstGapMinutes ?? DEFAULT_BURST_GAP_MINUTES) * 60_000;
  const minEvents = options.burstMinEvents ?? DEFAULT_BURST_MIN_EVENTS;
  const sorted = events.slice().sort(compareMomentEvents);

  const items: MomentTimelineItem[] = [];
  let run: MomentEvent[] = [];

  const flush = () => {
    const first = run[0];
    if (first === undefined) return;
    if (run.length >= minEvents && first.resourceId) {
      const covering = new Set<string>();
      for (const event of run) {
        for (const span of incidentsCovering(event.timestamp, incidents)) covering.add(span.id);
      }
      items.push({
        kind: "burst",
        key: `burst:${first.id}`,
        resourceId: first.resourceId,
        resourceName: first.resourceName ?? null,
        events: run,
        incidentIds: Array.from(covering),
      });
    } else {
      for (const event of run) {
        items.push({
          kind: "event",
          key: event.id,
          event,
          incidentIds: incidentsCovering(event.timestamp, incidents).map((span) => span.id),
        });
      }
    }
    run = [];
  };

  for (const event of sorted) {
    const prev = run[run.length - 1];
    const sameResource =
      prev !== undefined &&
      Boolean(event.resourceId) &&
      prev.resourceId === event.resourceId &&
      Date.parse(event.timestamp) - Date.parse(prev.timestamp) <= gapMs;
    if (!sameResource) flush();
    run.push(event);
  }
  flush();
  return items;
}

/* ------------------------------------------------------------------ *
 * Reading the union (Bearer hosts) + URL state
 * ------------------------------------------------------------------ */

export interface MomentRequest {
  /** ISO centre timestamp. Omitted = "around now" (server uses its clock). */
  at?: string | undefined;
  /** Half-window in minutes; server clamps to `MOMENT_WINDOW_LIMITS`. */
  windowMinutes?: number | undefined;
}

/**
 * Query string for a moment request, without the leading `?`. Invalid dates
 * and non-finite windows are dropped rather than sent, mirroring
 * `changeFeedSearchParams` — a half-filled picker must not turn the server's
 * `new Date(...)` into an Invalid Date comparison.
 */
export function momentSearchParams(request: MomentRequest): string {
  const params = new URLSearchParams();
  if (request.at && !Number.isNaN(Date.parse(request.at))) params.set("at", request.at);
  if (typeof request.windowMinutes === "number" && Number.isFinite(request.windowMinutes)) {
    params.set("window", String(request.windowMinutes));
  }
  return params.toString();
}

/** The merged window — `GET /api/org/{orgId}/moment`. */
export async function fetchMoment(
  api: CloudFetch,
  orgId: string,
  request: MomentRequest = {},
): Promise<MomentResponse | null> {
  const query = momentSearchParams(request);
  return api.org<MomentResponse>(orgId, query ? `/moment?${query}` : "/moment");
}
