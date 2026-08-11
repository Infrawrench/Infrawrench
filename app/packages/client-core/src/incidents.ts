/**
 * **Incident mode** — the shared contract for `/api/org/:orgId/incidents`.
 *
 * An *incident* here is an operational incident **your organisation declared**,
 * not a provider outage. The other thing called an incident in this codebase —
 * `status-incidents.ts`, `OrgStatusIncident`, `provider_status_incidents` — is
 * a **provider** status-page entry we scrape and correlate. They are different
 * objects with a colliding English word, and they meet in exactly one place:
 * a provider incident overlapping a declared incident's window shows up on the
 * declared incident's timeline as evidence. Every type in this module is
 * prefixed `Incident*`; the provider ones are all `*StatusIncident*`.
 *
 * This module is the pure half every surface shares:
 *
 * - the wire types both ends of the HTTP boundary compile against,
 * - {@link buildIncidentTimeline}, which merges the timeline **on read** from
 *   sources that already exist (no rows are copied into the incident's own
 *   tables — the timeline is a join, and re-running it after the fact gives
 *   the record as it stands today rather than a snapshot),
 * - {@link renderPostmortemMarkdown}, so the export the browser previews and
 *   the one the API returns are byte-identical.
 *
 * The plugin-base import stance of `probes.ts` applies: nothing here imports
 * anything with a runtime cost, so mobile and the CLI can use it as-is.
 */

import type { CloudFetch } from "./fetch";
import type { MomentEvent, MomentSeverity } from "./moment";

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * Severity, in the ordinary sev1..sev4 register rather than a bespoke one —
 * at 03:14 nobody wants to learn a new scale. Ordered most severe first, which
 * is also the list order every picker renders.
 */
export const INCIDENT_SEVERITIES = [
  {
    id: "sev1",
    label: "SEV1",
    description: "Complete outage or data loss. All hands.",
  },
  {
    id: "sev2",
    label: "SEV2",
    description: "Major functionality broken for many users.",
  },
  {
    id: "sev3",
    label: "SEV3",
    description: "Partial or degraded service, with a workaround.",
  },
  {
    id: "sev4",
    label: "SEV4",
    description: "Minor or cosmetic. Tracked, not paged.",
  },
] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number]["id"];

export const DEFAULT_INCIDENT_SEVERITY: IncidentSeverity = "sev2";

/** Rank for sorting/comparison — lower is worse. */
export function incidentSeverityRank(severity: IncidentSeverity): number {
  const index = INCIDENT_SEVERITIES.findIndex((s) => s.id === severity);
  return index === -1 ? INCIDENT_SEVERITIES.length : index;
}

export function incidentSeverityLabel(severity: string): string {
  return INCIDENT_SEVERITIES.find((s) => s.id === severity)?.label ?? severity.toUpperCase();
}

/**
 * Three states, and the middle one is the point.
 *
 * `mitigated` is "users are fine again, we are not finished" — the moment the
 * page stops and the write-up starts. Collapsing it into `resolved` is what
 * makes every postmortem's "time to mitigate" a guess, and collapsing it into
 * `open` is what keeps people paged after the bleeding stopped.
 */
export const INCIDENT_STATUSES = ["open", "mitigated", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export function incidentStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "mitigated":
      return "Mitigated";
    case "resolved":
      return "Resolved";
    default:
      return status;
  }
}

/* ------------------------------------------------------------------ *
 * Artefacts — the six things declaring used to mean doing by hand
 * ------------------------------------------------------------------ */

/**
 * The side effects a declaration can perform. Each is **opt-in per
 * declaration**; each produces exactly one artefact row so the incident
 * remembers what it created, and so resolving can undo precisely what it did
 * and nothing else.
 */
export const INCIDENT_ARTIFACT_KINDS = ["freeze", "moment", "slack", "status-page"] as const;
export type IncidentArtifactKind = (typeof INCIDENT_ARTIFACT_KINDS)[number];

export const INCIDENT_ARTIFACT_LABELS: Record<IncidentArtifactKind, string> = {
  freeze: "Change freeze",
  moment: "Pinned moment",
  slack: "Slack",
  "status-page": "Status page",
};

/**
 * Artefact lifecycle. The **entire partial-failure stance of this feature** is
 * in the fact that `failed` is a stored state rather than a thrown error:
 * declaring an incident must never be lost because Slack was down, so every
 * side effect is attempted after the incident row is durable and its outcome
 * is written back. A failure is surfaced on the incident (and on the timeline)
 * instead of being swallowed, and can be retried from the detail view.
 */
export const INCIDENT_ARTIFACT_STATUSES = ["created", "failed", "closed"] as const;
export type IncidentArtifactStatus = (typeof INCIDENT_ARTIFACT_STATUSES)[number];

export interface IncidentArtifact {
  id: string;
  kind: IncidentArtifactKind;
  status: IncidentArtifactStatus;
  /** Human label, e.g. the freeze name or `#incidents`. */
  label: string | null;
  /** Primary reference: freeze id, status-page notice id, Slack channel id… */
  refId: string | null;
  /** Secondary reference: Slack message `ts`, moment window minutes… */
  refSecondary: string | null;
  /** Why it failed, verbatim enough to act on. Null unless `status` is failed. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * The incident itself
 * ------------------------------------------------------------------ */

export interface IncidentNote {
  id: string;
  body: string;
  authorUserId: string | null;
  authorName: string | null;
  /**
   * When the note is *about* — defaults to when it was written, but an
   * operator catching up at 04:00 can date a note to 03:14 and have it land in
   * the right place on the timeline.
   */
  occurredAt: string;
  createdAt: string;
}

/** Wire shape of an incident row, as every list and detail endpoint returns it. */
export interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  /** One paragraph of "what is going on", editable throughout. */
  summary: string | null;
  startedAt: string;
  mitigatedAt: string | null;
  resolvedAt: string | null;
  declaredByUserId: string | null;
  declaredByName: string | null;
  resolvedByUserId: string | null;
  /** Resource ids believed affected. Advisory — not foreign keys. */
  affectedResourceIds: string[];
  /** Account ids believed affected. */
  affectedAccountIds: string[];
  /** Where the write-up was filed, once someone filed it. */
  issueUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** Artefacts this declaration created, including the ones that failed. */
  artifacts: IncidentArtifact[];
  noteCount: number;
}

export interface IncidentListResponse {
  incidents: Incident[];
}

export interface IncidentDetailResponse {
  incident: Incident;
  notes: IncidentNote[];
}

/** Bounds shared by the editors and the API boundary, so they cannot disagree. */
export const INCIDENT_LIMITS = {
  maxTitleLength: 200,
  maxSummaryLength: 4000,
  maxNoteLength: 4000,
  maxAffectedResources: 200,
  maxAffectedAccounts: 50,
  /** Timeline entries returned per incident, newest sources truncated first. */
  maxTimelineEntries: 1000,
} as const;

/**
 * What a declaration should *do*, beyond recording itself. Every flag defaults
 * to something defensible for a fresh declaration (see
 * {@link defaultIncidentActions}) and every one is overridable at the moment of
 * declaring — the whole point is that a person at 03:14 confirms a form rather
 * than performing six errands.
 */
export interface IncidentActions {
  /** Open an org change freeze for the duration. Lifted on resolve. */
  openFreeze?: boolean;
  /** Pin the moment (`at` + window) so "what changed around then" is one click. */
  pinMoment?: boolean;
  /** Announce in Slack through the org's alert routing rules. */
  postSlack?: boolean;
  /** Post an update on a public status page. Needs `statusPageId`. */
  statusPageId?: string | null;
  /** Component ids on that page to mark affected; empty means the whole page. */
  statusPageComponentIds?: string[];
}

/**
 * Defaults, chosen so that accepting them is the right answer more often than
 * not: tell people (Slack), pin the moment (free, and the investigation always
 * wants it), and do **not** freeze or publish — those two have blast radius
 * beyond the incident and should be a deliberate tick.
 */
export function defaultIncidentActions(): Required<
  Pick<IncidentActions, "openFreeze" | "pinMoment" | "postSlack">
> {
  return { openFreeze: false, pinMoment: true, postSlack: true };
}

/** Body of `POST /api/org/:orgId/incidents`. */
export interface IncidentDeclare {
  title: string;
  severity?: IncidentSeverity;
  summary?: string | null;
  /** Defaults to now. Backdating is allowed — people declare late. */
  startedAt?: string;
  affectedResourceIds?: string[];
  affectedAccountIds?: string[];
  actions?: IncidentActions;
}

/** Body of `PATCH /api/org/:orgId/incidents/:id`. Omitted fields keep their value. */
export interface IncidentPatch {
  title?: string;
  severity?: IncidentSeverity;
  /** Setting `mitigated` stamps `mitigatedAt`; `resolved` runs the resolve path. */
  status?: IncidentStatus;
  summary?: string | null;
  affectedResourceIds?: string[];
  affectedAccountIds?: string[];
  issueUrl?: string | null;
}

export interface IncidentNoteCreate {
  body: string;
  /** ISO; defaults to now. */
  occurredAt?: string;
}

/* ------------------------------------------------------------------ *
 * Timeline
 * ------------------------------------------------------------------ */

/**
 * Where a timeline entry came from. `moment` covers everything the moment
 * union already indexes (resource changes, deploys, cost anomalies, provider
 * incidents, audit, freezes, workflow runs) — reusing that one loader is why
 * this feature adds no new feed plumbing.
 */
export const INCIDENT_TIMELINE_SOURCES = [
  "incident",
  "note",
  "artifact",
  "moment",
  "probe",
  "metric-alert",
] as const;
export type IncidentTimelineSource = (typeof INCIDENT_TIMELINE_SOURCES)[number];

const SOURCE_ORDER: Record<IncidentTimelineSource, number> = INCIDENT_TIMELINE_SOURCES.reduce(
  (acc, source, index) => {
    acc[source] = index;
    return acc;
  },
  {} as Record<IncidentTimelineSource, number>,
);

/**
 * Where a timeline row should deep-link. This is `MomentEventLink` widened by
 * two kinds the moment union has no events for (`probe`, `metric-alert`) and
 * with the collision renamed: a moment link of kind `incident` means a
 * **provider** status incident, so it arrives here as `provider-incident` and
 * `incident` is free to mean the declared incident itself. Hosts map each kind
 * onto their own screen; `url` is absolute and wins when present.
 */
export interface IncidentTimelineLink {
  kind:
    | "resource"
    | "changes"
    | "provider-incident"
    | "costs"
    | "workflow-run"
    | "deployment"
    | "audit"
    | "freeze"
    | "expiring"
    | "probe"
    | "metric-alert"
    | "incident";
  id?: string | null;
  parentId?: string | null;
  url?: string | null;
}

/** One row on an incident's timeline, whatever it was assembled from. */
export interface IncidentTimelineEntry {
  /** Stable within a response: `<source>:<rowId>[:<phase>]`. */
  id: string;
  source: IncidentTimelineSource;
  /** `<noun>.<verb>` — `incident.declared`, `artifact.failed`, `probe.down`… */
  kind: string;
  at: string;
  title: string;
  detail?: string | null;
  severity: MomentSeverity;
  /** Present on operator notes. */
  authorName?: string | null;
  resourceId?: string | null;
  resourceName?: string | null;
  pluginId?: string | null;
  accountId?: string | null;
  link?: IncidentTimelineLink | null;
}

/** A probe that changed state inside the window. */
export interface IncidentProbeTransition {
  probeId: string;
  probeName: string;
  status: "up" | "down" | "unknown";
  changedAt: string;
  lastError?: string | null;
  resourceId?: string | null;
}

/** A metric-alert event that fired (or resolved) inside the window. */
export interface IncidentMetricAlertEvent {
  eventId: string;
  ruleName: string;
  resourceId: string | null;
  resourceName: string | null;
  observedValue: number | null;
  firedAt: string;
  resolvedAt?: string | null;
}

/** Everything {@link buildIncidentTimeline} needs. Deliberately all data. */
export interface IncidentTimelineInput {
  incident: Incident;
  notes: IncidentNote[];
  /** Already-unioned moment events for the window (see web `services/moment.ts`). */
  events: MomentEvent[];
  probeTransitions: IncidentProbeTransition[];
  metricAlertEvents: IncidentMetricAlertEvent[];
  /** Upper bound of the window; the caller's clock for an unresolved incident. */
  now: string;
  /** Cap on returned entries. Defaults to `INCIDENT_LIMITS.maxTimelineEntries`. */
  limit?: number;
}

export interface IncidentTimelineResponse {
  incidentId: string;
  from: string;
  to: string;
  generatedAt: string;
  entries: IncidentTimelineEntry[];
  /** Per-feed health from the underlying moment union, passed through. */
  feeds: Array<{ feed: string; status: "ok" | "omitted" | "error"; error?: string | null }>;
  /** True when `limit` cut the list. */
  truncated: boolean;
}

/** `[startedAt, resolvedAt ?? now]` as epoch ms. Unparseable input becomes NaN. */
export function incidentWindow(
  incident: Pick<Incident, "startedAt" | "resolvedAt">,
  now: string | Date = new Date(),
): { fromMs: number; toMs: number } {
  const fromMs = Date.parse(incident.startedAt);
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  const toMs = incident.resolvedAt ? Date.parse(incident.resolvedAt) : nowMs;
  return { fromMs, toMs };
}

/**
 * Chronological (oldest first) with deterministic tie-breaks — source order,
 * then id — so two assemblies of the same data agree, and so an entry that
 * shares a timestamp with the declaration (the artefacts always do) lands in a
 * stable place instead of shuffling on every refresh.
 */
export function compareIncidentTimelineEntries(
  a: IncidentTimelineEntry,
  b: IncidentTimelineEntry,
): number {
  const at = Date.parse(a.at);
  const bt = Date.parse(b.at);
  if (Number.isNaN(at) !== Number.isNaN(bt)) return Number.isNaN(at) ? 1 : -1;
  if (!Number.isNaN(at) && at !== bt) return at < bt ? -1 : 1;
  const source = (SOURCE_ORDER[a.source] ?? 99) - (SOURCE_ORDER[b.source] ?? 99);
  if (source !== 0) return source;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Translate a moment event's link into a timeline link, renaming the one kind
 * whose word collides (`incident` there means a provider status incident).
 */
function momentLinkToTimelineLink(event: MomentEvent): IncidentTimelineLink | null {
  const link = event.link;
  if (!link) return null;
  return {
    kind: link.kind === "incident" ? "provider-incident" : link.kind,
    id: link.id ?? null,
    parentId: link.parentId ?? null,
    url: link.url ?? null,
  };
}

function artifactEntry(
  incidentId: string,
  artifact: IncidentArtifact,
): IncidentTimelineEntry | null {
  const label = INCIDENT_ARTIFACT_LABELS[artifact.kind] ?? artifact.kind;
  if (artifact.status === "failed") {
    return {
      id: `artifact:${artifact.id}:failed`,
      source: "artifact",
      kind: "artifact.failed",
      at: artifact.updatedAt,
      title: `${label} could not be created`,
      // The error is the whole value of recording a failure — an artefact that
      // says only "failed" sends the operator back to the surface that failed.
      detail: artifact.error ?? "No detail was recorded.",
      severity: "critical",
      link: { kind: "incident", id: incidentId },
    };
  }
  if (artifact.status === "closed") {
    return {
      id: `artifact:${artifact.id}:closed`,
      source: "artifact",
      kind: "artifact.closed",
      at: artifact.updatedAt,
      title: `${label} closed`,
      detail: artifact.label,
      severity: "info",
      link: { kind: "incident", id: incidentId },
    };
  }
  return {
    id: `artifact:${artifact.id}`,
    source: "artifact",
    kind: "artifact.created",
    at: artifact.createdAt,
    title: `${label} created`,
    detail: artifact.label,
    severity: "info",
    link: { kind: "incident", id: incidentId },
  };
}

/**
 * Merge everything recorded between an incident's start and its resolution
 * into one ordered list. **Pure** — the caller does every query, this does
 * every decision — which is what makes ordering across sources, an empty
 * window and a half-created declaration all testable without a database.
 *
 * Three rules worth stating:
 *
 * 1. **Nothing is copied.** Source rows arrive as arguments and leave as
 *    entries; the incident's own tables hold only the incident, its notes and
 *    its artefacts.
 * 2. **The window is inclusive at both ends** and is `[startedAt, resolvedAt ??
 *    now]`. An entry outside it is dropped even if the caller passed it, so a
 *    loader with a sloppier range cannot widen the incident's story.
 * 3. **The incident's own life events are always present** — declared, and
 *    mitigated/resolved when they happened — because a timeline that begins
 *    with a resource change and never says "we declared this" reads as though
 *    the tooling noticed before the humans did.
 */
export function buildIncidentTimeline(input: IncidentTimelineInput): {
  entries: IncidentTimelineEntry[];
  from: string;
  to: string;
  truncated: boolean;
} {
  const { incident, notes, events, probeTransitions, metricAlertEvents } = input;
  const limit = input.limit ?? INCIDENT_LIMITS.maxTimelineEntries;
  const { fromMs, toMs } = incidentWindow(incident, input.now);

  const inWindow = (iso: string | null | undefined): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return false;
    if (!Number.isNaN(fromMs) && t < fromMs) return false;
    if (!Number.isNaN(toMs) && t > toMs) return false;
    return true;
  };

  const entries: IncidentTimelineEntry[] = [];

  // 1. The incident's own life events.
  entries.push({
    id: `incident:${incident.id}:declared`,
    source: "incident",
    kind: "incident.declared",
    at: incident.startedAt,
    title: `${incidentSeverityLabel(incident.severity)} declared: ${incident.title}`,
    detail: incident.declaredByName ? `Declared by ${incident.declaredByName}` : incident.summary,
    severity: "critical",
    link: { kind: "incident", id: incident.id },
  });
  if (incident.mitigatedAt) {
    entries.push({
      id: `incident:${incident.id}:mitigated`,
      source: "incident",
      kind: "incident.mitigated",
      at: incident.mitigatedAt,
      title: "Mitigated",
      detail: "Impact stopped; the incident stayed open for follow-up.",
      severity: "warning",
      link: { kind: "incident", id: incident.id },
    });
  }
  if (incident.resolvedAt) {
    entries.push({
      id: `incident:${incident.id}:resolved`,
      source: "incident",
      kind: "incident.resolved",
      at: incident.resolvedAt,
      title: "Resolved",
      detail: `Duration ${formatIncidentDuration(incident.startedAt, incident.resolvedAt)}.`,
      severity: "info",
      link: { kind: "incident", id: incident.id },
    });
  }

  // 2. Artefacts — including the failures, which is the point.
  for (const artifact of incident.artifacts) {
    const entry = artifactEntry(incident.id, artifact);
    if (entry) entries.push(entry);
  }

  // 3. Operator notes.
  for (const note of notes) {
    if (!inWindow(note.occurredAt)) continue;
    entries.push({
      id: `note:${note.id}`,
      source: "note",
      kind: "note",
      at: note.occurredAt,
      title: note.body,
      severity: "info",
      authorName: note.authorName,
      link: { kind: "incident", id: incident.id },
    });
  }

  // 4. Everything the moment union already indexes.
  for (const event of events) {
    if (!inWindow(event.timestamp)) continue;
    entries.push({
      id: `moment:${event.id}`,
      source: "moment",
      kind: event.kind,
      at: event.timestamp,
      title: event.title,
      detail: event.detail ?? null,
      severity: event.severity,
      resourceId: event.resourceId ?? null,
      resourceName: event.resourceName ?? null,
      pluginId: event.pluginId ?? null,
      accountId: event.accountId ?? null,
      link: momentLinkToTimelineLink(event),
    });
  }

  // 5. Probe state transitions.
  for (const probe of probeTransitions) {
    if (!inWindow(probe.changedAt)) continue;
    const down = probe.status === "down";
    entries.push({
      id: `probe:${probe.probeId}:${probe.changedAt}`,
      source: "probe",
      kind: down ? "probe.down" : "probe.up",
      at: probe.changedAt,
      title: `${probe.probeName} went ${down ? "down" : "up"}`,
      detail: down ? (probe.lastError ?? null) : null,
      severity: down ? "critical" : "info",
      resourceId: probe.resourceId ?? null,
      link: { kind: "probe", id: probe.probeId },
    });
  }

  // 6. Metric-alert firings and recoveries — two entries from one row, so a
  //    rule that fired and cleared inside the window reads as a shape rather
  //    than a point.
  for (const alert of metricAlertEvents) {
    if (inWindow(alert.firedAt)) {
      const observed =
        alert.observedValue === null ? null : `Observed ${formatNumber(alert.observedValue)}`;
      entries.push({
        id: `metric-alert:${alert.eventId}:fired`,
        source: "metric-alert",
        kind: "metric-alert.fired",
        at: alert.firedAt,
        title: `${alert.ruleName} fired${alert.resourceName ? ` on ${alert.resourceName}` : ""}`,
        detail: observed,
        severity: "critical",
        resourceId: alert.resourceId,
        resourceName: alert.resourceName,
        link: { kind: "metric-alert", id: alert.eventId },
      });
    }
    if (alert.resolvedAt && inWindow(alert.resolvedAt)) {
      entries.push({
        id: `metric-alert:${alert.eventId}:resolved`,
        source: "metric-alert",
        kind: "metric-alert.resolved",
        at: alert.resolvedAt,
        title: `${alert.ruleName} recovered${alert.resourceName ? ` on ${alert.resourceName}` : ""}`,
        severity: "info",
        resourceId: alert.resourceId,
        resourceName: alert.resourceName,
        link: { kind: "metric-alert", id: alert.eventId },
      });
    }
  }

  entries.sort(compareIncidentTimelineEntries);
  const truncated = entries.length > limit;
  return {
    entries: truncated ? entries.slice(0, limit) : entries,
    from: new Date(Number.isNaN(fromMs) ? 0 : fromMs).toISOString(),
    to: new Date(Number.isNaN(toMs) ? 0 : toMs).toISOString(),
    truncated,
  };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Duration + postmortem
 * ------------------------------------------------------------------ */

/** `"1h 42m"`, `"14m"`, `"—"` for an unparseable or open-ended span. */
export function formatIncidentDuration(
  startedAt: string,
  endedAt: string | null | undefined,
): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const totalMinutes = Math.round((end - start) / 60_000);
  if (totalMinutes < 1) return "under a minute";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

/** A resource named on the postmortem — resolved by the caller, if it can. */
export interface PostmortemResource {
  resourceId: string;
  displayName?: string | null;
  pluginId?: string | null;
  resourceTypeId?: string | null;
}

export interface PostmortemInput {
  incident: Incident;
  timeline: IncidentTimelineEntry[];
  resources: PostmortemResource[];
  notes: IncidentNote[];
  /** Absolute link back to the incident, when the caller knows the origin. */
  incidentUrl?: string | null;
  now?: string;
}

function isoToDisplay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

/**
 * The postmortem document, pre-filled from what is already known: the window,
 * the duration, the affected resources, the merged timeline and the notes.
 *
 * The blank sections at the end (impact, root cause, action items) are
 * deliberately blank. A generated document that guesses at a root cause is
 * worse than one that leaves a heading — this exports the facts nobody enjoys
 * transcribing and stops exactly where judgement starts.
 *
 * Pure, so the preview a browser renders and the file the API serves are the
 * same bytes.
 */
export function renderPostmortemMarkdown(input: PostmortemInput): string {
  const { incident, timeline, resources, notes } = input;
  const lines: string[] = [];

  lines.push(`# ${incident.title}`);
  lines.push("");
  lines.push(
    `**${incidentSeverityLabel(incident.severity)}** · ${incidentStatusLabel(incident.status)}`,
  );
  lines.push("");
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push(`| Started | ${isoToDisplay(incident.startedAt)} |`);
  lines.push(
    `| Mitigated | ${incident.mitigatedAt ? isoToDisplay(incident.mitigatedAt) : "not recorded"} |`,
  );
  lines.push(
    `| Resolved | ${incident.resolvedAt ? isoToDisplay(incident.resolvedAt) : "still open"} |`,
  );
  lines.push(
    `| Duration | ${formatIncidentDuration(incident.startedAt, incident.resolvedAt ?? input.now ?? null)} |`,
  );
  lines.push(
    `| Time to mitigate | ${incident.mitigatedAt ? formatIncidentDuration(incident.startedAt, incident.mitigatedAt) : "not recorded"} |`,
  );
  lines.push(`| Declared by | ${incident.declaredByName ?? "unknown"} |`);
  if (input.incidentUrl) lines.push(`| Incident | ${input.incidentUrl} |`);
  lines.push("");

  if (incident.summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(incident.summary);
    lines.push("");
  }

  lines.push("## Affected resources");
  lines.push("");
  if (resources.length === 0) {
    lines.push("_None recorded._");
  } else {
    for (const resource of resources) {
      const name = resource.displayName ?? resource.resourceId;
      const suffix = resource.pluginId
        ? ` (${resource.pluginId}${resource.resourceTypeId ? `/${resource.resourceTypeId}` : ""})`
        : "";
      lines.push(`- ${name}${suffix}`);
    }
  }
  lines.push("");

  lines.push("## Timeline");
  lines.push("");
  if (timeline.length === 0) {
    lines.push("_Nothing was recorded in the incident window._");
  } else {
    lines.push("| Time | Source | What happened |");
    lines.push("| --- | --- | --- |");
    for (const entry of timeline) {
      const what = entry.detail ? `${entry.title} — ${entry.detail}` : entry.title;
      lines.push(`| ${isoToDisplay(entry.at)} | ${entry.source} | ${escapePipes(what)} |`);
    }
  }
  lines.push("");

  lines.push("## Notes");
  lines.push("");
  if (notes.length === 0) {
    lines.push("_No operator notes were written._");
  } else {
    for (const note of notes) {
      const who = note.authorName ? ` — ${note.authorName}` : "";
      lines.push(`- **${isoToDisplay(note.occurredAt)}**${who}: ${note.body}`);
    }
  }
  lines.push("");

  if (incident.artifacts.length > 0) {
    lines.push("## Artefacts");
    lines.push("");
    for (const artifact of incident.artifacts) {
      const label = INCIDENT_ARTIFACT_LABELS[artifact.kind] ?? artifact.kind;
      const detail = artifact.status === "failed" ? ` — ${artifact.error ?? "failed"}` : "";
      lines.push(
        `- ${label}: ${artifact.status}${artifact.label ? ` (${artifact.label})` : ""}${detail}`,
      );
    }
    lines.push("");
  }

  lines.push("## Impact");
  lines.push("");
  lines.push("<!-- Who was affected, how badly, and for how long. -->");
  lines.push("");
  lines.push("## Root cause");
  lines.push("");
  lines.push("<!-- What actually broke, and why it was able to. -->");
  lines.push("");
  lines.push("## What went well / what did not");
  lines.push("");
  lines.push("<!-- Detection, escalation, communication, tooling. -->");
  lines.push("");
  lines.push("## Action items");
  lines.push("");
  lines.push("- [ ] ");
  lines.push("");

  return lines.join("\n");
}

/** Suggested filename for a downloaded postmortem. */
export function postmortemFilename(incident: Pick<Incident, "title" | "startedAt">): string {
  const day = incident.startedAt.slice(0, 10);
  const slug =
    incident.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "incident";
  return `postmortem-${day}-${slug}.md`;
}

/* ------------------------------------------------------------------ *
 * Bearer fetch helpers (mobile, CLI, any host talking the cloud API)
 * ------------------------------------------------------------------ */

/** `GET /api/org/:orgId/incidents` (permission `incidents:read`). */
export async function fetchIncidents(
  api: CloudFetch,
  orgId: string,
  options: { status?: IncidentStatus | "all" } = {},
): Promise<IncidentListResponse> {
  const query = options.status && options.status !== "all" ? `?status=${options.status}` : "";
  const res = await api.org<IncidentListResponse>(orgId, `/incidents${query}`);
  return res ?? { incidents: [] };
}

/** `GET /api/org/:orgId/incidents/:id` (permission `incidents:read`). */
export async function fetchIncident(
  api: CloudFetch,
  orgId: string,
  incidentId: string,
): Promise<IncidentDetailResponse | null> {
  return api.org<IncidentDetailResponse>(orgId, `/incidents/${encodeURIComponent(incidentId)}`);
}

/** `GET /api/org/:orgId/incidents/:id/timeline` (permission `incidents:read`). */
export async function fetchIncidentTimeline(
  api: CloudFetch,
  orgId: string,
  incidentId: string,
): Promise<IncidentTimelineResponse | null> {
  return api.org<IncidentTimelineResponse>(
    orgId,
    `/incidents/${encodeURIComponent(incidentId)}/timeline`,
  );
}

/** Declare an incident (`incidents:write`). */
export async function declareIncident(
  api: CloudFetch,
  orgId: string,
  body: IncidentDeclare,
): Promise<Incident | null> {
  return api.org<Incident>(orgId, "/incidents", { method: "POST", body: JSON.stringify(body) });
}

/** Edit or transition an incident (`incidents:write`). */
export async function updateIncident(
  api: CloudFetch,
  orgId: string,
  incidentId: string,
  patch: IncidentPatch,
): Promise<Incident | null> {
  return api.org<Incident>(orgId, `/incidents/${encodeURIComponent(incidentId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Add a timestamped operator note (`incidents:write`). */
export async function addIncidentNote(
  api: CloudFetch,
  orgId: string,
  incidentId: string,
  body: IncidentNoteCreate,
): Promise<IncidentNote | null> {
  return api.org<IncidentNote>(orgId, `/incidents/${encodeURIComponent(incidentId)}/notes`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** The pre-filled postmortem markdown (`incidents:read`). */
export async function fetchIncidentPostmortem(
  api: CloudFetch,
  orgId: string,
  incidentId: string,
): Promise<{ markdown: string; filename: string } | null> {
  return api.org<{ markdown: string; filename: string }>(
    orgId,
    `/incidents/${encodeURIComponent(incidentId)}/postmortem`,
  );
}
