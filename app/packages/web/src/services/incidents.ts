/**
 * **Incident mode** — the composition layer.
 *
 * Declaring an incident is one object that performs the six errands somebody
 * currently runs by hand at 03:14: record the thing, freeze changes, pin the
 * moment, tell Slack, tell the public, and then keep a timeline so the write-up
 * afterwards is an edit rather than an archaeology project.
 *
 * Everything here **composes**; almost nothing here implements.
 *
 * - freezing is `services/change-freezes.ts` (`createChangeFreeze`, `endChangeFreeze`)
 * - the moment is `services/moment.ts` (`computeMoment`) — and it is also the
 *   timeline's engine, which is why this feature adds no feed plumbing
 * - Slack is `alerts/route.ts` (`routeAlert`), so the org's routing rules,
 *   quiet hours, escalation and the acknowledge button all apply unchanged
 * - the public update is `status-pages/notices.ts`
 * - the merge and the postmortem are the pure functions in
 *   `client-core/src/incidents.ts`
 *
 * ## The partial-failure stance
 *
 * The incident row is written **first**, alone, and every artefact is attempted
 * afterwards with its outcome written back to `incident_artifacts`. Nothing an
 * integration does can lose the declaration, and nothing that fails is
 * swallowed: a failed artefact carries its error, renders on the incident and
 * on its own timeline, and can be retried. The inverse — doing the errands
 * inside a transaction with the insert — would mean a Slack outage at 03:14
 * deletes the incident somebody just declared, which is the exact moment the
 * record matters most.
 *
 * (`status-incidents.ts` is the unrelated feature with the colliding word: a
 * *provider's* status page reporting *their* outage. It appears here only as
 * timeline evidence.)
 */
import { and, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import {
  buildIncidentTimeline,
  planIncidentArtifactRetry,
  postmortemFilename,
  renderPostmortemMarkdown,
  type Incident,
  type IncidentActions,
  type IncidentArtifactStatus,
  type IncidentMetricAlertEvent,
  type IncidentNote,
  type IncidentProbeTransition,
  type IncidentSeverity,
  type IncidentTimelineResponse,
  type PostmortemResource,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { routeAlert } from "@infrawrench/server-core/alerts/route";
import {
  createStatusPageNotice,
  resolveStatusPageNotice,
} from "@infrawrench/server-core/status-pages/notices";
import {
  IncidentInputError,
  addIncidentNoteRecord,
  closeIncidentArtifact,
  createIncidentRecord,
  getIncidentArtifact,
  getIncidentRecord,
  listIncidentNoteRecords,
  markIncidentArtifactCloseFailed,
  recordIncidentArtifact,
  updateIncidentRecord,
  type IncidentCreateInput,
} from "@infrawrench/server-core/incidents/store";

import { db } from "@/db/client";
import { metricAlertEvents, resources, syntheticProbes } from "@/db/schema";
import { createChangeFreeze, endChangeFreeze } from "./change-freezes";
import { computeMoment } from "./moment";
import { logAudit } from "./audit";

export { IncidentInputError };

/** Everything the composition needs about the caller. */
export interface IncidentActor {
  userId: string | null;
  permissions: readonly string[];
  /** Absolute app origin, for deep links in Slack and on the status page. */
  appUrl?: string | null;
}

/** Half-window (minutes) a pinned moment gets. Wide enough to catch the deploy. */
const PINNED_MOMENT_WINDOW_MINUTES = 60;

function incidentUrl(
  actor: IncidentActor,
  organizationId: string,
  incidentId: string,
): string | null {
  const origin = actor.appUrl?.replace(/\/+$/, "");
  if (!origin) return null;
  return `${origin}/org/${encodeURIComponent(organizationId)}/incidents/${encodeURIComponent(incidentId)}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ------------------------------------------------------------------ *
 * Declare
 * ------------------------------------------------------------------ */

export interface DeclareIncidentInput extends IncidentCreateInput {
  actions?: IncidentActions | undefined;
}

/**
 * Record the incident, then perform the opted-in errands.
 *
 * Returns the incident **re-read after the artefacts settled**, so the caller's
 * response already shows which of them worked. A caller that got a 201 knows
 * the incident exists; the artefact list tells it what else happened.
 */
export async function declareIncident(
  organizationId: string,
  input: DeclareIncidentInput,
  actor: IncidentActor,
): Promise<Incident> {
  // 1. The durable part. If this throws, nothing else has happened yet.
  const incident = await createIncidentRecord(organizationId, input, actor.userId);
  const actions = input.actions ?? {};
  const url = incidentUrl(actor, organizationId, incident.id);

  await logAudit({
    organizationId,
    userId: actor.userId ?? undefined,
    action: "incident.declare",
    entityType: "incident",
    entityId: incident.id,
    metadata: {
      title: incident.title,
      severity: incident.severity,
      actions: {
        openFreeze: Boolean(actions.openFreeze),
        pinMoment: actions.pinMoment !== false,
        postSlack: actions.postSlack !== false,
        statusPageId: actions.statusPageId ?? null,
      },
    },
  });

  // 2. The errands. Each is independent, each records its own outcome, and one
  //    failing never stops the next — an org that loses Slack should still get
  //    its freeze.
  await Promise.all([
    actions.pinMoment !== false ? pinMoment(incident) : Promise.resolve(),
    actions.openFreeze ? openFreeze(organizationId, incident, actor) : Promise.resolve(),
    actions.postSlack !== false
      ? announce(organizationId, incident, actor, url, "declared")
      : Promise.resolve(),
    actions.statusPageId
      ? publishNotice(
          organizationId,
          incident,
          actions.statusPageId,
          actions.statusPageComponentIds,
        )
      : Promise.resolve(),
  ]);

  return (await getIncidentRecord(organizationId, incident.id)) ?? incident;
}

/**
 * Pin the moment. This one cannot fail — it stores a timestamp and a window,
 * nothing more — which is exactly why it is on by default: the investigation
 * always wants "what changed around then", and asking for it later means
 * reconstructing when "then" was.
 */
async function pinMoment(incident: Incident): Promise<void> {
  await recordIncidentArtifact(incident.id, {
    kind: "moment",
    status: "created",
    label: `±${PINNED_MOMENT_WINDOW_MINUTES}m around ${incident.startedAt}`,
    refId: incident.startedAt,
    refSecondary: String(PINNED_MOMENT_WINDOW_MINUTES),
  });
}

/**
 * Open a change freeze for the incident's duration.
 *
 * The permission check is here and not at the route: `incidents:write` is
 * deliberately reachable by members (declaring is operational, not
 * governance), while `freezes:write` is not. Rather than either escalating
 * privilege or refusing the whole declaration, the freeze is recorded as a
 * failed artefact naming the missing permission — the incident stands, and the
 * person who declared it can see what they need to ask for.
 */
async function openFreeze(
  organizationId: string,
  incident: Incident,
  actor: IncidentActor,
): Promise<void> {
  if (!hasPermission(actor.permissions, "freezes:write")) {
    await recordIncidentArtifact(incident.id, {
      kind: "freeze",
      status: "failed",
      error: "Opening a change freeze needs the freezes:write permission.",
    });
    return;
  }
  try {
    const freeze = await createChangeFreeze(
      organizationId,
      {
        name: `Incident: ${incident.title}`,
        reason: `Automatically opened when this incident was declared. Lifted on resolve.`,
      },
      actor.userId,
    );
    await recordIncidentArtifact(incident.id, {
      kind: "freeze",
      status: "created",
      label: freeze.name,
      refId: freeze.id,
    });
    await logAudit({
      organizationId,
      userId: actor.userId ?? undefined,
      action: "change_freeze.create",
      entityType: "change_freeze",
      entityId: freeze.id,
      metadata: { viaIncidentId: incident.id },
    });
  } catch (error) {
    await recordIncidentArtifact(incident.id, {
      kind: "freeze",
      status: "failed",
      error: errorText(error),
    });
  }
}

/**
 * Announce through the org's alert routing rules rather than posting into a
 * channel directly.
 *
 * That choice is what makes the incident message obey everything an org has
 * already configured — which channels, which Teams webhooks, which phones,
 * quiet hours, escalation, the acknowledge button — instead of inventing a
 * second, parallel notion of "where alerts go" that would drift from the first.
 *
 * `unrouted` is treated as a failure and says so, because "we posted it and
 * nobody is listening" is indistinguishable from success at 03:14 unless
 * somebody tells you.
 */
async function announce(
  organizationId: string,
  incident: Incident,
  actor: IncidentActor,
  url: string | null,
  phase: "declared" | "mitigated" | "resolved",
): Promise<void> {
  const severityWord = incident.severity.toUpperCase();
  const title =
    phase === "declared"
      ? `${severityWord} declared: ${incident.title}`
      : phase === "mitigated"
        ? `${severityWord} mitigated: ${incident.title}`
        : `${severityWord} resolved: ${incident.title}`;
  const bodyLines: string[] = [];
  if (incident.summary) bodyLines.push(incident.summary);
  if (incident.affectedResourceIds.length > 0) {
    bodyLines.push(`Affected resources: ${incident.affectedResourceIds.length}`);
  }
  if (phase !== "declared") {
    bodyLines.push(`Started ${incident.startedAt}.`);
  }
  if (bodyLines.length === 0) bodyLines.push("No summary was given.");

  try {
    const result = await routeAlert(
      {
        organizationId,
        trigger: "incidentAlerts",
        severity:
          incident.severity === "sev1" || incident.severity === "sev2" ? "critical" : "warning",
        title,
        body: bodyLines.join("\n"),
        pushBody: incident.summary ?? incident.title,
        ...(incident.declaredByName ? { context: `Declared by ${incident.declaredByName}` } : {}),
        url,
        pushData: {
          type: "incident",
          orgId: organizationId,
          incidentId: incident.id,
          status: phase === "declared" ? "open" : phase,
        },
        // `facts` are what routing rules match on. An incident names no single
        // account or resource — it usually names several — so it offers none
        // rather than picking one arbitrarily and letting a scoped rule fire
        // for a reason nobody could reconstruct.
      },
      // Tracked so the resolution can be threaded under the announcement it is
      // resolving, rather than arriving as an unattached second message.
      { track: true },
    );

    if (result.unrouted) {
      await recordIncidentArtifact(incident.id, {
        kind: "slack",
        status: "failed",
        error:
          "No alert routing rule matches the Incidents trigger, so nobody was told. " +
          "Add a rule under Settings → Alert routing.",
      });
      return;
    }
    if (result.succeeded === 0 && result.held === 0) {
      await recordIncidentArtifact(incident.id, {
        kind: "slack",
        status: "failed",
        error: `Every destination failed (${result.attempted} attempted).`,
      });
      return;
    }
    const first = result.slackMessages[0];
    await recordIncidentArtifact(incident.id, {
      kind: "slack",
      status: "created",
      label: `${result.succeeded} destination${result.succeeded === 1 ? "" : "s"}${
        result.held > 0 ? `, ${result.held} held by quiet hours` : ""
      }`,
      refId: first?.channelId ?? null,
      refSecondary: first?.ts ?? null,
    });
  } catch (error) {
    await recordIncidentArtifact(incident.id, {
      kind: "slack",
      status: "failed",
      error: errorText(error),
    });
  }
}

/** Post the "we know, we're on it" update to a public status page. */
async function publishNotice(
  organizationId: string,
  incident: Incident,
  statusPageId: string,
  componentIds: readonly string[] | undefined,
): Promise<void> {
  // Recorded on the failure path too, and that is the point: a retry reads this
  // back, so the second attempt names the same components as the first. Without
  // it the retry would fall back to "no components", which on a status page
  // means *the whole page* — quietly widening a customer-visible outage
  // announcement as a side effect of pressing Retry.
  const request = { statusPageId, componentIds: [...(componentIds ?? [])] };
  try {
    const notice = await createStatusPageNotice({
      organizationId,
      statusPageId,
      incidentId: incident.id,
      title: incident.title,
      body: incident.summary,
      state: "investigating",
      affectedComponentIds: componentIds ?? [],
      startedAt: new Date(incident.startedAt),
    });
    await recordIncidentArtifact(incident.id, {
      kind: "status-page",
      status: "created",
      label: notice.title,
      refId: notice.id,
      refSecondary: statusPageId,
      request,
    });
  } catch (error) {
    await recordIncidentArtifact(incident.id, {
      kind: "status-page",
      status: "failed",
      error: errorText(error),
      request,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Transition (mitigate / resolve / edit)
 * ------------------------------------------------------------------ */

export interface TransitionResult {
  incident: Incident;
}

/**
 * Apply a patch and, when it resolves the incident, undo exactly what this
 * incident created.
 *
 * "Exactly what this incident created" is the important half. The freeze that
 * gets lifted is the one whose id is on this incident's artefact — not
 * whichever freeze happens to be in effect, which might be a planned change
 * window somebody else opened and which resolving an unrelated incident has no
 * business ending.
 */
export async function patchIncident(
  organizationId: string,
  incidentId: string,
  patch: Parameters<typeof updateIncidentRecord>[2],
  actor: IncidentActor,
): Promise<Incident | null> {
  const before = await getIncidentRecord(organizationId, incidentId);
  if (!before) return null;

  const after = await updateIncidentRecord(organizationId, incidentId, patch, actor.userId);
  if (!after) return null;

  const becameResolved = before.status !== "resolved" && after.status === "resolved";
  const becameMitigated = before.status === "open" && after.status === "mitigated";

  if (becameResolved) {
    await Promise.all([
      liftFreeze(organizationId, after, actor),
      closeNotice(after),
      announce(
        organizationId,
        after,
        actor,
        incidentUrl(actor, organizationId, after.id),
        "resolved",
      ),
    ]);
  } else if (becameMitigated) {
    await announce(
      organizationId,
      after,
      actor,
      incidentUrl(actor, organizationId, after.id),
      "mitigated",
    );
  }

  if (before.status !== after.status) {
    await logAudit({
      organizationId,
      userId: actor.userId ?? undefined,
      action: `incident.${after.status}`,
      entityType: "incident",
      entityId: after.id,
      metadata: { from: before.status, to: after.status },
    });
  }

  return (await getIncidentRecord(organizationId, incidentId)) ?? after;
}

/**
 * Which artefact states still have something to close.
 *
 * `created` is the ordinary case. `close_failed` is a previous close that threw
 * — the freeze or the notice is still out there, so the work is still owed and
 * a retry must be allowed to attempt it again.
 */
function isCloseable(status: IncidentArtifactStatus): boolean {
  return status === "created" || status === "close_failed";
}

async function liftFreeze(
  organizationId: string,
  incident: Incident,
  actor: IncidentActor,
): Promise<void> {
  const artifact = await getIncidentArtifact(incident.id, "freeze");
  // `close_failed` is included so a retry can finish what resolving started.
  if (!artifact || !isCloseable(artifact.status) || !artifact.refId) return;
  try {
    const ended = await endChangeFreeze(organizationId, artifact.refId, actor.userId);
    if (!ended) {
      // Somebody deleted the freeze by hand. That is a legitimate outcome, not
      // an error — the incident's freeze is gone, which is what resolving wanted.
      await closeIncidentArtifact(incident.id, "freeze");
      return;
    }
    await closeIncidentArtifact(incident.id, "freeze");
    await logAudit({
      organizationId,
      userId: actor.userId ?? undefined,
      action: "change_freeze.end",
      entityType: "change_freeze",
      entityId: ended.id,
      metadata: { viaIncidentId: incident.id },
    });
  } catch (error) {
    await markIncidentArtifactCloseFailed(
      incident.id,
      "freeze",
      `Could not lift: ${errorText(error)}`,
    );
  }
}

async function closeNotice(incident: Incident): Promise<void> {
  const artifact = await getIncidentArtifact(incident.id, "status-page");
  if (!artifact || !isCloseable(artifact.status) || !artifact.refId) return;
  try {
    await resolveStatusPageNotice(artifact.refId, incident.summary ?? null);
    await closeIncidentArtifact(incident.id, "status-page");
  } catch (error) {
    await markIncidentArtifactCloseFailed(
      incident.id,
      "status-page",
      `Could not close the public update: ${errorText(error)}`,
    );
  }
}

/**
 * Retry whichever artefacts are in a failure state. Only those are re-run.
 *
 * "Failure state" is two states, and they need opposite work — the split is
 * decided by the pure {@link planIncidentArtifactRetry} so the rule is testable
 * without a database:
 *
 * - **`failed`** — never created. Run the creating half again.
 * - **`close_failed`** — created, and resolving could not put it away. Run the
 *   *closing* half. Re-creating one of these would open a second change freeze
 *   or post a duplicate public notice.
 *
 * The status-page re-creation reads its component list back off the artefact's
 * recorded request rather than defaulting to none, so a retry announces against
 * the components the operator actually picked.
 */
export async function retryIncidentArtifacts(
  organizationId: string,
  incidentId: string,
  actor: IncidentActor,
): Promise<Incident | null> {
  const incident = await getIncidentRecord(organizationId, incidentId);
  if (!incident) return null;

  const { recreate, reclose } = planIncidentArtifactRetry(incident);
  if (recreate.length === 0 && reclose.length === 0) return incident;

  const recreateKinds = new Set(recreate.map((a) => a.kind));
  const recloseKinds = new Set(reclose.map((a) => a.kind));
  const statusPageArtifact = recreate.find((a) => a.kind === "status-page");
  const statusPageId =
    statusPageArtifact?.request?.statusPageId ?? statusPageArtifact?.refSecondary ?? null;

  await Promise.all([
    recreateKinds.has("moment") ? pinMoment(incident) : Promise.resolve(),
    recreateKinds.has("freeze") ? openFreeze(organizationId, incident, actor) : Promise.resolve(),
    recreateKinds.has("slack")
      ? announce(
          organizationId,
          incident,
          actor,
          incidentUrl(actor, organizationId, incident.id),
          incident.status === "resolved" ? "resolved" : "declared",
        )
      : Promise.resolve(),
    recreateKinds.has("status-page") && statusPageId
      ? publishNotice(
          organizationId,
          incident,
          statusPageId,
          statusPageArtifact?.request?.componentIds ?? [],
        )
      : Promise.resolve(),
    // The closing half. Both are no-ops unless the artefact is still closeable.
    recloseKinds.has("freeze") ? liftFreeze(organizationId, incident, actor) : Promise.resolve(),
    recloseKinds.has("status-page") ? closeNotice(incident) : Promise.resolve(),
  ]);
  return getIncidentRecord(organizationId, incidentId);
}

/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

export async function addNote(
  organizationId: string,
  incidentId: string,
  body: string,
  occurredAt: Date | undefined,
  actor: IncidentActor,
): Promise<IncidentNote | null> {
  const incident = await getIncidentRecord(organizationId, incidentId);
  if (!incident) return null;
  return addIncidentNoteRecord(incidentId, body, actor.userId, occurredAt);
}

/* ------------------------------------------------------------------ *
 * Timeline — a join, never a copy
 * ------------------------------------------------------------------ */

/**
 * Assemble the incident's timeline from what is already recorded.
 *
 * `computeMoment` does the heavy lifting for six of the sources, because it
 * already unions them with per-feed permission gating and per-feed partial
 * failure — reimplementing that here would be a second copy of nine queries
 * that could silently disagree with the Moment screen about what happened. It
 * is asked for the incident's window expressed as a centre and a half-width,
 * which is the shape its API takes.
 *
 * Two sources the moment union has no events for are queried here: probe state
 * transitions and metric-alert firings. The probe one is an **approximation and
 * says so** — `synthetic_probes` keeps only `last_state_change_at`, a single
 * overwritten timestamp, so a probe that flapped twice inside the window
 * contributes its most recent flip and no more. The honest fix is a probe
 * transition log, which is a change to the probes feature rather than to this
 * one.
 *
 * The merge itself is `buildIncidentTimeline` in client-core: pure, and the
 * only place that decides ordering, windowing and what an artefact looks like.
 */
export async function assembleIncidentTimeline(
  organizationId: string,
  incident: Incident,
  actor: IncidentActor,
): Promise<IncidentTimelineResponse> {
  const now = new Date();
  const from = new Date(incident.startedAt);
  const to = incident.resolvedAt ? new Date(incident.resolvedAt) : now;
  const centre = new Date((from.getTime() + to.getTime()) / 2);
  // Half-width, plus a minute so both endpoints are inside the queried span
  // rather than exactly on its boundary.
  const halfWindowMinutes = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 120_000) + 1);

  const [moment, notes, probeTransitions, metricEvents] = await Promise.all([
    computeMoment(organizationId, {
      at: centre,
      windowMinutes: halfWindowMinutes,
      permissions: actor.permissions,
    }).catch(() => null),
    listIncidentNoteRecords(incident.id),
    loadProbeTransitions(organizationId, from, to, actor.permissions),
    loadMetricAlertEvents(organizationId, from, to, actor.permissions),
  ]);

  const built = buildIncidentTimeline({
    incident,
    notes,
    events: moment?.events ?? [],
    probeTransitions,
    metricAlertEvents: metricEvents,
    now: now.toISOString(),
  });

  const feeds: IncidentTimelineResponse["feeds"] = moment
    ? moment.feeds.map((feed) => ({
        feed: feed.feed,
        status: feed.status,
        error: feed.error ?? null,
      }))
    : [{ feed: "moment", status: "error" as const, error: "The moment union could not be read." }];

  return {
    incidentId: incident.id,
    from: built.from,
    to: built.to,
    generatedAt: now.toISOString(),
    entries: built.entries,
    feeds,
    truncated: built.truncated,
  };
}

/**
 * Probes whose one recorded state change lands inside the window.
 *
 * Gated on `resources:read`, the same permission the probes API itself uses.
 */
async function loadProbeTransitions(
  organizationId: string,
  from: Date,
  to: Date,
  permissions: readonly string[],
): Promise<IncidentProbeTransition[]> {
  if (!hasPermission(permissions, "resources:read")) return [];
  try {
    const rows = await db
      .select({
        id: syntheticProbes.id,
        name: syntheticProbes.name,
        status: syntheticProbes.status,
        lastStateChangeAt: syntheticProbes.lastStateChangeAt,
        lastError: syntheticProbes.lastError,
        resourceId: syntheticProbes.resourceId,
      })
      .from(syntheticProbes)
      .where(
        and(
          eq(syntheticProbes.organizationId, organizationId),
          gte(syntheticProbes.lastStateChangeAt, from),
          lte(syntheticProbes.lastStateChangeAt, to),
        ),
      )
      .limit(200);
    return rows.flatMap((row) =>
      row.lastStateChangeAt
        ? [
            {
              probeId: row.id,
              probeName: row.name,
              status: row.status,
              changedAt: row.lastStateChangeAt.toISOString(),
              lastError: row.lastError,
              resourceId: row.resourceId,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

/** Metric-alert rows that fired or recovered inside the window. */
async function loadMetricAlertEvents(
  organizationId: string,
  from: Date,
  to: Date,
  permissions: readonly string[],
): Promise<IncidentMetricAlertEvent[]> {
  if (!hasPermission(permissions, "metric-alerts:read")) return [];
  try {
    const rows = await db
      .select()
      .from(metricAlertEvents)
      .where(
        and(
          eq(metricAlertEvents.organizationId, organizationId),
          or(
            and(gte(metricAlertEvents.firedAt, from), lte(metricAlertEvents.firedAt, to)),
            and(gte(metricAlertEvents.resolvedAt, from), lte(metricAlertEvents.resolvedAt, to)),
          ),
        ),
      )
      .orderBy(desc(metricAlertEvents.firedAt))
      .limit(200);
    return rows.map((row) => ({
      eventId: row.id,
      ruleName: row.ruleName,
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      observedValue: row.observedValue,
      firedAt: row.firedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Postmortem
 * ------------------------------------------------------------------ */

/**
 * The pre-filled write-up. Rendering is the pure `renderPostmortemMarkdown`, so
 * the preview the browser shows and the file the API serves are the same bytes;
 * this function only supplies what a pure function cannot know — the display
 * names behind the affected resource ids.
 */
export async function buildPostmortem(
  organizationId: string,
  incident: Incident,
  actor: IncidentActor,
): Promise<{ markdown: string; filename: string }> {
  const [timeline, notes, named] = await Promise.all([
    assembleIncidentTimeline(organizationId, incident, actor),
    listIncidentNoteRecords(incident.id),
    lookupResources(organizationId, incident.affectedResourceIds),
  ]);

  return {
    markdown: renderPostmortemMarkdown({
      incident,
      timeline: timeline.entries,
      resources: named,
      notes,
      incidentUrl: incidentUrl(actor, organizationId, incident.id),
      now: new Date().toISOString(),
    }),
    filename: postmortemFilename(incident),
  };
}

/**
 * Resolve ids to names, keeping every id the caller named.
 *
 * A resource that has been deleted since — which, during an incident, is a
 * thing that happens — still appears, under its id. Dropping it would make the
 * postmortem quietly disagree with the incident about what was affected.
 */
async function lookupResources(
  organizationId: string,
  resourceIds: readonly string[],
): Promise<PostmortemResource[]> {
  if (resourceIds.length === 0) return [];
  const rows = await db
    .select({
      id: resources.id,
      displayName: resources.displayName,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
    })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        inArray(resources.id, resourceIds as string[]),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return resourceIds.map((resourceId) => {
    const row = byId.get(resourceId);
    return {
      resourceId,
      displayName: row?.displayName ?? null,
      pluginId: row?.pluginId ?? null,
      resourceTypeId: row?.resourceTypeId ?? null,
    };
  });
}

/** Re-exported so routes have one import for the read path. */
export { getIncidentRecord, listIncidentNoteRecords, type IncidentSeverity };
