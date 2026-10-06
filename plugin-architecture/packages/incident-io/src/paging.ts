/**
 * incident.io's half of the paging-provider capability (`plugin-base/paging.ts`).
 *
 * - **Targets** are HTTP alert sources. `GET /v2/alert_sources` returns each
 *   source's `secret_token` and `alert_events_url`, so the user picks a source
 *   by name and never copies a token. Events go to
 *   `POST /v2/alert_events/http/{id}` with that token as the bearer:
 *   `{title, description, status: firing|resolved, deduplication_key,
 *   source_url, metadata}`. There is no acknowledged status for an alert
 *   (`supportsAcknowledgeEvent: false`); acknowledging happens on the
 *   escalation it opened.
 * - **On-call** sources are schedules (`schedule:<id>`, read with
 *   `GET /v2/schedule_entries` and its `final` entries) and escalation paths
 *   (`path:<id>`, whose `current_responders` are who it would page now).
 * - **Incidents** are declared incidents. Status categories map to the
 *   capability's three states: triage is triggered, live and paused are
 *   acknowledged, everything else is resolved. Acknowledging moves a triage
 *   incident to the first live status; resolving moves it to a closed status,
 *   falling back to a post-incident (learning) status when the account's
 *   lifecycle requires one.
 * - **Webhooks** cannot be created through the API (Settings, Webhooks in the
 *   dashboard), so the mode is `manual`. They are signed Svix-style:
 *   `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, the
 *   signature being base64 HMAC-SHA256 over `${id}.${timestamp}.${body}` with
 *   the base64-decoded `whsec_` secret, several space-separated `v1,<sig>`
 *   entries allowed. Timestamps older than five minutes are rejected.
 */
import type {
  PagingEvent,
  PagingEventResult,
  PagingIncident,
  PagingIncidentQuery,
  PagingIncidentUpdate,
  PagingOnCallPerson,
  PagingOnCallSource,
  PagingTarget,
  PagingWebhookRequest,
  PagingWebhookResult,
} from "@infrawrench/plugin-base";
import {
  base64ToBytes,
  bytesToBase64,
  constantTimeEqual,
  hmacSha256,
  rejectedPagingWebhook,
} from "@infrawrench/plugin-base";
import type { IncidentIoTransport } from "./api.js";
import { IncidentIoApiError, ioFetch, ioList, statusOf } from "./api.js";
import type {
  IoAlertSource,
  IoEscalation,
  IoEscalationPath,
  IoIncident,
  IoIncidentStatus,
  IoSchedule,
  IoShift,
} from "./mappers.js";
import { OPEN_CATEGORIES, toPagingIncident } from "./mappers.js";

export const SCHEDULE_PREFIX = "schedule:";
export const PATH_PREFIX = "path:";
/** Webhook deliveries older (or newer) than this are rejected as replays. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
const TITLE_LIMIT = 500;

export interface PagingContext {
  transport: IncidentIoTransport;
  /** Sources read this client's lifetime, by id. */
  sources: Map<string, Promise<IoAlertSource | null>>;
}

/** HTTP sources with a token Infrawrench can send with. */
export function isSendableSource(s: IoAlertSource): boolean {
  return (s.source_type === "http" || s.source_type === "http_custom") && Boolean(s.secret_token);
}

async function alertSources(ctx: PagingContext): Promise<IoAlertSource[]> {
  const res = await ioFetch<{ alert_sources?: IoAlertSource[] }>(
    ctx.transport,
    "/v2/alert_sources",
  );
  return res?.alert_sources ?? [];
}

export async function listTargets(ctx: PagingContext): Promise<PagingTarget[]> {
  return (await alertSources(ctx)).filter(isSendableSource).map((s) => ({
    id: s.id ?? "",
    name: s.name ?? s.id ?? "",
    description: "HTTP alert source",
  }));
}

function sourceFor(ctx: PagingContext, targetId: string): Promise<IoAlertSource | null> {
  const cached = ctx.sources.get(targetId);
  if (cached) return cached;
  const lookup = ioFetch<{ alert_source?: IoAlertSource }>(
    ctx.transport,
    `/v2/alert_sources/${encodeURIComponent(targetId)}`,
  )
    .then((res) => res?.alert_source ?? null)
    .catch((err: unknown) => {
      ctx.sources.delete(targetId);
      throw err;
    });
  ctx.sources.set(targetId, lookup);
  return lookup;
}

export function buildAlertEvent(event: PagingEvent): Record<string, unknown> {
  const title =
    event.summary.length > TITLE_LIMIT
      ? `${event.summary.slice(0, TITLE_LIMIT - 1)}…`
      : event.summary;
  return {
    title,
    status: event.action === "resolve" ? "resolved" : "firing",
    deduplication_key: event.dedupKey,
    ...(event.body ? { description: event.body } : {}),
    ...(event.url ? { source_url: event.url } : {}),
    metadata: {
      severity: event.severity,
      source: event.source,
      ...(event.timestamp ? { raised_at: event.timestamp } : {}),
      ...(event.details ?? {}),
    },
  };
}

export async function sendPagingEvent(
  ctx: PagingContext,
  targetId: string,
  event: PagingEvent,
): Promise<PagingEventResult> {
  // incident.io alerts have no acknowledged state; the host does not ask, but
  // a stray call is a no-op rather than an accidental re-fire.
  if (event.action === "acknowledge") return { dedupKey: event.dedupKey };
  const source = await sourceFor(ctx, targetId);
  if (!source?.secret_token) {
    ctx.sources.delete(targetId);
    throw new IncidentIoApiError(
      404,
      "That incident.io alert source has no secret token: it must be an HTTP source",
    );
  }
  try {
    const res = await ioFetch<{ deduplication_key?: string }>(
      ctx.transport,
      `/v2/alert_events/http/${encodeURIComponent(targetId)}`,
      { body: buildAlertEvent(event), token: source.secret_token },
    );
    return { dedupKey: res?.deduplication_key ?? event.dedupKey };
  } catch (err) {
    // A rotated token answers 401; read the source again next time.
    if (statusOf(err) === 401 || statusOf(err) === 404) ctx.sources.delete(targetId);
    throw err;
  }
}

export async function listOnCallSources(ctx: PagingContext): Promise<PagingOnCallSource[]> {
  const [schedules, paths] = await Promise.all([
    ioList<IoSchedule>(ctx.transport, "/v2/schedules", "schedules", {}, { pageSize: 100 }),
    ioList<IoEscalationPath>(
      ctx.transport,
      "/v2/escalation_paths",
      "escalation_paths",
      {},
      {
        pageSize: 25,
      },
    ),
  ]);
  return [
    ...schedules.map((s) => ({
      id: `${SCHEDULE_PREFIX}${s.id ?? ""}`,
      name: s.name ?? s.id ?? "",
      kind: "schedule" as const,
    })),
    ...paths.map((p) => ({
      id: `${PATH_PREFIX}${p.id ?? ""}`,
      name: p.name ?? p.id ?? "",
      kind: "escalation-policy" as const,
    })),
  ];
}

export async function resolveOnCall(
  ctx: PagingContext,
  sourceId: string,
  at: Date,
): Promise<PagingOnCallPerson[]> {
  if (sourceId.startsWith(SCHEDULE_PREFIX)) {
    const id = sourceId.slice(SCHEDULE_PREFIX.length);
    const res = await ioFetch<{ schedule_entries?: { final?: IoShift[] } }>(
      ctx.transport,
      "/v2/schedule_entries",
      {
        query: {
          schedule_id: id,
          entry_window_start: at.toISOString(),
          entry_window_end: new Date(at.getTime() + 60_000).toISOString(),
        },
      },
    );
    const seen = new Set<string>();
    const out: PagingOnCallPerson[] = [];
    for (const entry of res?.schedule_entries?.final ?? []) {
      const start = entry.start_at ? Date.parse(entry.start_at) : -Infinity;
      const end = entry.end_at ? Date.parse(entry.end_at) : Infinity;
      if (start > at.getTime() || end <= at.getTime()) continue;
      const userId = entry.user?.id ?? "";
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      out.push({
        userId,
        name: entry.user?.name ?? null,
        email: entry.user?.email ?? null,
        until: entry.end_at ?? null,
        level: 1,
      });
    }
    return out;
  }
  if (sourceId.startsWith(PATH_PREFIX)) {
    const id = sourceId.slice(PATH_PREFIX.length);
    const res = await ioFetch<{ escalation_path?: IoEscalationPath }>(
      ctx.transport,
      `/v2/escalation_paths/${encodeURIComponent(id)}`,
    );
    return (res?.escalation_path?.current_responders ?? []).map((u) => ({
      userId: u.id ?? "",
      name: u.name ?? null,
      email: u.email ?? null,
      level: 1,
    }));
  }
  throw new IncidentIoApiError(400, `Unknown on-call source "${sourceId}"`);
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function listIncidents(
  ctx: PagingContext,
  query: PagingIncidentQuery,
): Promise<PagingIncident[]> {
  const [open, recent] = await Promise.all([
    ioList<IoIncident>(
      ctx.transport,
      "/v2/incidents",
      "incidents",
      { status_category: { one_of: OPEN_CATEGORIES } },
      { pageSize: 250, maxItems: 1000 },
    ),
    query.includeResolved === false
      ? Promise.resolve([] as IoIncident[])
      : ioList<IoIncident>(
          ctx.transport,
          "/v2/incidents",
          "incidents",
          // The date filters take a day; the window is widened to it.
          { updated_at: { gte: [day(query.since)] } },
          { pageSize: 250, maxItems: 1000 },
        ),
  ]);
  const byId = new Map<string, IoIncident>();
  for (const i of [...recent, ...open]) {
    // Test and tutorial incidents are not pages anyone answers.
    if (i.id && (i.mode ?? "standard") === "standard") byId.set(i.id, i);
  }
  return [...byId.values()].map(toPagingIncident);
}

export async function getIncident(
  ctx: PagingContext,
  incidentId: string,
): Promise<PagingIncident | null> {
  try {
    const res = await ioFetch<{ incident?: IoIncident }>(
      ctx.transport,
      `/v2/incidents/${encodeURIComponent(incidentId)}`,
    );
    return res?.incident ? toPagingIncident(res.incident) : null;
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

/** The account's statuses in rank order, for picking where to move an incident. */
export async function incidentStatuses(
  transport: IncidentIoTransport,
): Promise<IoIncidentStatus[]> {
  const res = await ioFetch<{ incident_statuses?: IoIncidentStatus[] }>(
    transport,
    "/v1/incident_statuses",
  );
  return [...(res?.incident_statuses ?? [])].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
}

async function editStatus(
  transport: IncidentIoTransport,
  incidentId: string,
  statusId: string,
): Promise<IoIncident | undefined> {
  const res = await ioFetch<{ incident?: IoIncident }>(
    transport,
    `/v2/incidents/${encodeURIComponent(incidentId)}/actions/edit`,
    { body: { incident: { incident_status_id: statusId }, notify_incident_channel: true } },
  );
  return res?.incident;
}

export async function updateIncident(
  ctx: PagingContext,
  incidentId: string,
  update: PagingIncidentUpdate,
): Promise<PagingIncident> {
  const statuses = await incidentStatuses(ctx.transport);
  const candidates =
    update.action === "acknowledge"
      ? statuses.filter((s) => s.category === "live")
      : [
          ...statuses.filter((s) => s.category === "closed"),
          ...statuses.filter((s) => s.category === "learning"),
        ];
  if (candidates.length === 0) {
    throw new IncidentIoApiError(
      400,
      `This incident.io account has no ${update.action === "acknowledge" ? "active" : "closed or post-incident"} status to move the incident to`,
    );
  }
  let lastError: unknown;
  for (const status of candidates) {
    try {
      const updated = await editStatus(ctx.transport, incidentId, status.id ?? "");
      if (update.note) {
        await ioFetch(ctx.transport, "/v2/incident_updates", {
          body: {
            incident_id: incidentId,
            message: update.note,
            idempotency_key: `infrawrench-${incidentId}-${Date.now()}`,
          },
        }).catch(() => undefined);
      }
      return (
        (await getIncident(ctx, incidentId)) ??
        toPagingIncident(updated ?? { id: incidentId, incident_status: status })
      );
    } catch (err) {
      lastError = err;
      // A 400/422 means this status is not allowed from here (a closed status
      // when the lifecycle requires a post-incident flow): try the next one.
      const code = statusOf(err);
      if (code !== 400 && code !== 422) throw err;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function secretBytes(secret: string): Uint8Array<ArrayBuffer> | null {
  const raw = secret.trim().replace(/^whsec_/, "");
  try {
    return base64ToBytes(raw);
  } catch {
    return null;
  }
}

/** Svix signature check. Returns false for anything malformed. */
export async function verifySvixSignature(request: PagingWebhookRequest): Promise<boolean> {
  const id = request.headers["webhook-id"] ?? "";
  const timestamp = request.headers["webhook-timestamp"] ?? "";
  const header = request.headers["webhook-signature"] ?? "";
  if (!id || !timestamp || !header || !request.secret) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  if (Math.abs(request.now.getTime() - seconds * 1000) > WEBHOOK_TOLERANCE_MS) return false;
  const key = secretBytes(request.secret);
  if (!key || key.length === 0) return false;
  const expected = bytesToBase64(await hmacSha256(key, `${id}.${timestamp}.${request.body}`));
  return header
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .some((s) => constantTimeEqual(s.slice(3), expected));
}

interface WebhookBody {
  event_type?: string;
  [key: string]: unknown;
}

export async function verifyWebhook(request: PagingWebhookRequest): Promise<PagingWebhookResult> {
  if (!(await verifySvixSignature(request))) return rejectedPagingWebhook();
  const result: PagingWebhookResult = {
    valid: true,
    incidentIds: [],
    acknowledgedDedupKeys: [],
    resolvedDedupKeys: [],
  };
  let body: WebhookBody;
  try {
    body = JSON.parse(request.body) as WebhookBody;
  } catch {
    return result;
  }
  const type = body.event_type ?? "";
  const payload = (body[type] ?? {}) as Record<string, unknown>;

  if (
    type.startsWith("public_incident.incident_") ||
    type.startsWith("private_incident.incident_")
  ) {
    // `incident_status_updated_v2` nests the incident; the others are the incident.
    const incident = (payload["incident"] as { id?: string } | undefined) ?? payload;
    const id = (incident as { id?: unknown }).id;
    if (typeof id === "string" && id) result.incidentIds.push(id);
    return result;
  }
  if (type === "public_escalation.escalation_status_updated_v1") {
    const escalation = payload["escalation"] as IoEscalation | undefined;
    const keys = (escalation?.related_alerts ?? [])
      .map((a) => a.deduplication_key)
      .filter((k): k is string => Boolean(k));
    const status = payload["new_status"];
    if (status === "acked") result.acknowledgedDedupKeys.push(...keys);
    if (status === "resolved") result.resolvedDedupKeys.push(...keys);
    const actor = payload["actor"] as { user?: { email?: string } } | undefined;
    result.actorEmail = actor?.user?.email ?? null;
    return result;
  }
  if (type === "public_alert.alert_resolved_v1") {
    const key = payload["deduplication_key"];
    if (typeof key === "string" && key) result.resolvedDedupKeys.push(key);
  }
  return result;
}
