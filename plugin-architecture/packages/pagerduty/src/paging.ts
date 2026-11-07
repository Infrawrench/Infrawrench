/**
 * PagerDuty's half of the paging-provider capability (`plugin-base/paging.ts`).
 *
 * - **Targets** are services (and global event orchestrations, prefixed
 *   `orchestration:`). Sending needs a routing key, which the user never
 *   sees: for a service it is the integration key of an Events API v2
 *   integration, found with `GET /services/{id}?include[]=integrations` and
 *   created (`POST /services/{id}/integrations`, named "Infrawrench") when the
 *   service has none; for an orchestration it is
 *   `parameters.routing_key` from `GET /event_orchestrations/{id}/integrations`.
 * - **On-call** sources are schedules (`schedule:<id>`, read with
 *   `GET /schedules/{id}/users?since&until`) and escalation policies
 *   (`policy:<id>`, read with `GET /oncalls?escalation_policy_ids[]&include[]=users`,
 *   which also gives each person's escalation level and shift end).
 * - **Incidents** use the REST API; acknowledging and resolving need a
 *   `From:` user. The acting member's email is tried first, then the
 *   account's configured default user, so the action is attributed to the
 *   person who took it whenever PagerDuty knows them.
 * - **Webhooks** are v3 subscriptions (`POST /webhook_subscriptions`); the
 *   create response is the only place the signing secret is ever returned.
 *   Deliveries carry `X-PagerDuty-Signature: v1=<hex HMAC-SHA256 of the raw
 *   body>`, possibly several comma-separated during a secret rotation.
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
  PagingWebhookRegistration,
  PagingWebhookRequest,
  PagingWebhookResult,
} from "@infrawrench/plugin-base";
import {
  bytesToHex,
  constantTimeEqual,
  hmacSha256,
  pathEncode,
  rejectedPagingWebhook,
} from "@infrawrench/plugin-base";
import type { EventsApiBody, PagerDutyApi, PagerDutyEvents } from "./api.js";
import { PagerDutyApiError, sendEvent, statusOf } from "./api.js";
import type { PdExpandable, PdIncident, PdIntegration, PdOrchestration } from "./mappers.js";
import { toPagingIncident } from "./mappers.js";

export const ORCHESTRATION_PREFIX = "orchestration:";
export const SCHEDULE_PREFIX = "schedule:";
export const POLICY_PREFIX = "policy:";
export const INTEGRATION_NAME = "Infrawrench";
export const EVENTS_V2_TYPE = "events_api_v2_inbound_integration";

/** Incident events the webhook subscribes to: every status change, plus reassignment. */
export const WEBHOOK_EVENTS = [
  "incident.triggered",
  "incident.acknowledged",
  "incident.unacknowledged",
  "incident.resolved",
  "incident.reopened",
  "incident.reassigned",
  "incident.escalated",
  "incident.delegated",
  "incident.priority_updated",
  "incident.annotated",
];

/** Events API v2 caps `summary` at 1024 characters. */
const SUMMARY_LIMIT = 1024;

export interface PagingContext {
  api: PagerDutyApi;
  events: PagerDutyEvents;
  /** The account's default `From` user, when configured. */
  fromEmail: string;
  /** Routing keys resolved this client's lifetime, by target id. */
  routingKeys: Map<string, Promise<string>>;
}

export async function listTargets(ctx: PagingContext): Promise<PagingTarget[]> {
  const [services, orchestrations] = await Promise.all([
    // A picker: part of a very long list is better than no picker.
    ctx.api.getAll("/services", "services", {
      query: { "include[]": ["teams"], sort_by: "name" },
      partial: true,
    }),
    ctx.api.getAll("/event_orchestrations", "orchestrations", { partial: true }).catch(
      // Event orchestration needs AIOps or a newer plan on some accounts;
      // a 403 there must not hide the services.
      (): PdOrchestration[] => [],
    ),
  ]);
  return [
    ...services
      .filter((s) => s.status !== "disabled")
      .map((s) => ({
        id: s.id ?? "",
        name: s.name ?? s.id ?? "",
        ...(s.teams?.length ? { description: s.teams.map((t) => t.summary).join(", ") } : {}),
        url: s.html_url ?? null,
      })),
    ...orchestrations.map((o) => ({
      id: `${ORCHESTRATION_PREFIX}${o.id ?? ""}`,
      name: o.name ?? o.id ?? "",
      description: "Event orchestration",
    })),
  ];
}

/** The service's Events API v2 integration key, creating an Infrawrench integration if needed. */
export async function serviceRoutingKey(
  api: PagerDutyApi,
  serviceId: string,
  options: { create: boolean } = { create: true },
): Promise<string> {
  const id = pathEncode(serviceId);
  const res = await api.get(`/services/${id}`, { query: { "include[]": ["integrations"] } });
  const listed: PdIntegration[] = res?.service?.integrations ?? [];
  const integrations = listed.filter(
    (i) => i.type === EVENTS_V2_TYPE || i.type === `${EVENTS_V2_TYPE}_reference`,
  );
  // Prefer the integration Infrawrench made, so its alerts are labelled as
  // ours in PagerDuty; fall back to any Events API v2 integration.
  const ordered = [
    ...integrations.filter((i) => i.name === INTEGRATION_NAME || i.summary === INTEGRATION_NAME),
    ...integrations.filter((i) => i.name !== INTEGRATION_NAME && i.summary !== INTEGRATION_NAME),
  ];
  for (const candidate of ordered) {
    if (candidate.integration_key) return candidate.integration_key;
    if (!candidate.id) continue;
    const full = await api.get(`/services/${id}/integrations/${pathEncode(candidate.id)}`);
    if (full?.integration?.integration_key) return full.integration.integration_key;
  }
  if (!options.create) return "";
  const created = await api.post(`/services/${id}/integrations`, {
    body: {
      integration: {
        type: EVENTS_V2_TYPE,
        name: INTEGRATION_NAME,
        service: { id: serviceId, type: "service_reference" },
      },
    },
  });
  const key = created?.integration?.integration_key;
  if (!key) {
    throw new PagerDutyApiError(
      502,
      "PagerDuty created the Events API integration but returned no integration key",
    );
  }
  return key;
}

export async function orchestrationRoutingKey(
  api: PagerDutyApi,
  orchestrationId: string,
): Promise<string> {
  const res = await api.get(`/event_orchestrations/${pathEncode(orchestrationId)}/integrations`);
  const key = res?.integrations?.find((i) => i.parameters?.routing_key)?.parameters?.routing_key;
  if (!key) {
    throw new PagerDutyApiError(404, "That event orchestration has no routing key");
  }
  return key;
}

function routingKeyFor(ctx: PagingContext, targetId: string): Promise<string> {
  const cached = ctx.routingKeys.get(targetId);
  if (cached) return cached;
  const lookup = targetId.startsWith(ORCHESTRATION_PREFIX)
    ? orchestrationRoutingKey(ctx.api, targetId.slice(ORCHESTRATION_PREFIX.length))
    : serviceRoutingKey(ctx.api, targetId);
  // A failed lookup must not be cached, or one transient error would stick.
  const guarded = lookup.catch((err: unknown) => {
    ctx.routingKeys.delete(targetId);
    throw err;
  });
  ctx.routingKeys.set(targetId, guarded);
  return guarded;
}

/** Infrawrench severity → Events API severity (which also has `error`). */
function eventSeverity(severity: PagingEvent["severity"]): "critical" | "warning" | "info" {
  return severity;
}

export function buildEventBody(routingKey: string, event: PagingEvent): EventsApiBody {
  const body: EventsApiBody = {
    routing_key: routingKey,
    event_action: event.action,
    dedup_key: event.dedupKey.slice(0, 255),
  };
  if (event.action !== "trigger") return body;
  const summary =
    event.summary.length > SUMMARY_LIMIT
      ? `${event.summary.slice(0, SUMMARY_LIMIT - 1)}…`
      : event.summary;
  body.payload = {
    summary,
    source: event.source,
    severity: eventSeverity(event.severity),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    component: "infrawrench",
    ...(event.details?.["trigger"] ? { class: String(event.details["trigger"]) } : {}),
    custom_details: {
      ...(event.body ? { details: event.body } : {}),
      ...(event.details ?? {}),
    },
  };
  body.client = "Infrawrench";
  if (event.url) {
    body.client_url = event.url;
    body.links = [{ href: event.url, text: "Open in Infrawrench" }];
  }
  return body;
}

export async function sendPagingEvent(
  ctx: PagingContext,
  targetId: string,
  event: PagingEvent,
): Promise<PagingEventResult> {
  const routingKey = await routingKeyFor(ctx, targetId);
  try {
    const res = await sendEvent(ctx.events, buildEventBody(routingKey, event));
    return { dedupKey: res.dedupKey };
  } catch (err) {
    // A deleted integration answers 400 "Invalid routing key": forget the
    // cached key so the next attempt looks it up (and recreates it) again.
    if (statusOf(err) === 400 || statusOf(err) === 404) ctx.routingKeys.delete(targetId);
    throw err;
  }
}

export async function listOnCallSources(ctx: PagingContext): Promise<PagingOnCallSource[]> {
  // A picker: part of a very long list is better than no picker.
  const [schedules, policies] = await Promise.all([
    ctx.api.getAll("/schedules", "schedules", { partial: true }),
    ctx.api.getAll("/escalation_policies", "escalation_policies", {
      query: { sort_by: "name" },
      partial: true,
    }),
  ]);
  return [
    ...schedules.map((s) => ({
      id: `${SCHEDULE_PREFIX}${s.id ?? ""}`,
      name: s.name ?? s.id ?? "",
      kind: "schedule" as const,
    })),
    ...policies.map((p) => ({
      id: `${POLICY_PREFIX}${p.id ?? ""}`,
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
  const since = at.toISOString();
  const until = new Date(at.getTime() + 60_000).toISOString();
  if (sourceId.startsWith(SCHEDULE_PREFIX)) {
    const id = sourceId.slice(SCHEDULE_PREFIX.length);
    const res = await ctx.api.get(`/schedules/${pathEncode(id)}/users`, {
      query: { since, until },
    });
    return (res?.users ?? []).map((u) => ({
      userId: u.id ?? "",
      name: u.name ?? null,
      email: u.email ?? null,
      level: 1,
    }));
  }
  if (sourceId.startsWith(POLICY_PREFIX)) {
    const id = sourceId.slice(POLICY_PREFIX.length);
    const oncalls = await ctx.api.getAll("/oncalls", "oncalls", {
      query: { "escalation_policy_ids[]": [id], "include[]": ["users"], since, until },
    });
    const seen = new Set<string>();
    const out: PagingOnCallPerson[] = [];
    for (const oc of [...oncalls].sort(
      (a, b) => (a.escalation_level ?? 1) - (b.escalation_level ?? 1),
    )) {
      const user: PdExpandable | undefined = oc.user;
      const userId = user?.id ?? "";
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      out.push({
        userId,
        name: user?.name ?? user?.summary ?? null,
        email: user?.email ?? null,
        until: oc.end ?? null,
        level: oc.escalation_level ?? 1,
      });
    }
    return out;
  }
  throw new PagerDutyApiError(400, `Unknown on-call source "${sourceId}"`);
}

const INCIDENT_INCLUDES: ("assignees" | "acknowledgers" | "services")[] = [
  "assignees",
  "acknowledgers",
  "services",
];

export async function listIncidents(
  ctx: PagingContext,
  query: PagingIncidentQuery,
): Promise<PagingIncident[]> {
  // Two reads, because `since` filters on creation: every open incident
  // whatever its age (so an old one acknowledged today is seen), plus those
  // created in the window, which brings in recently resolved ones.
  const [open, recent] = await Promise.all([
    ctx.api.getAll("/incidents", "incidents", {
      query: {
        "statuses[]": ["triggered", "acknowledged"],
        date_range: "all",
        "include[]": INCIDENT_INCLUDES,
      },
    }),
    query.includeResolved === false
      ? Promise.resolve<PdIncident[]>([])
      : ctx.api.getAll("/incidents", "incidents", {
          query: {
            since: query.since.toISOString(),
            until: new Date().toISOString(),
            "statuses[]": ["resolved"],
            "include[]": INCIDENT_INCLUDES,
          },
        }),
  ]);
  const byId = new Map<string, PdIncident>();
  for (const i of [...recent, ...open]) if (i.id) byId.set(i.id, i);
  return [...byId.values()].map(toPagingIncident);
}

export async function getIncident(
  ctx: PagingContext,
  incidentId: string,
): Promise<PagingIncident | null> {
  try {
    const res = await ctx.api.get(`/incidents/${pathEncode(incidentId)}`, {
      query: { "include[]": INCIDENT_INCLUDES },
    });
    return res?.incident ? toPagingIncident(res.incident) : null;
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

/**
 * Run a write that needs a `From` user: the acting member first, then the
 * account's default. PagerDuty answers 400 (code 2100-ish "requester not
 * found") for an email it does not know; only that is retried.
 */
export async function withFrom<T>(
  ctx: PagingContext,
  actorEmail: string | null | undefined,
  run: (from: string) => Promise<T>,
): Promise<T> {
  const candidates = [...new Set([actorEmail ?? "", ctx.fromEmail].filter(Boolean))];
  if (candidates.length === 0) {
    throw new PagerDutyApiError(
      400,
      "PagerDuty needs to know which user is acting. Set the account's Default Acting User in its credentials.",
    );
  }
  let lastError: unknown;
  for (const from of candidates) {
    try {
      return await run(from);
    } catch (err) {
      lastError = err;
      if (statusOf(err) !== 400 && statusOf(err) !== 404) throw err;
    }
  }
  throw lastError;
}

export async function updateIncident(
  ctx: PagingContext,
  incidentId: string,
  update: PagingIncidentUpdate,
): Promise<PagingIncident> {
  const status = update.action === "resolve" ? "resolved" : "acknowledged";
  const id = pathEncode(incidentId);
  // `withFrom` runs this again as the next user, and by then the note may already be up.
  let notePosted = false;
  const res = await withFrom(ctx, update.actorEmail, async (from) => {
    if (update.note && !notePosted) {
      await ctx.api.post(`/incidents/${id}/notes`, {
        body: { note: { content: update.note } },
        headers: { From: from },
      });
      notePosted = true;
    }
    return ctx.api.put(`/incidents/${id}`, {
      body: { incident: { type: "incident_reference", status } },
      headers: { From: from },
    });
  });
  // The PUT answers without the expansions; re-read for assignee emails.
  return (
    (await getIncident(ctx, incidentId)) ??
    toPagingIncident(res?.incident ?? { id: incidentId, status })
  );
}

export async function registerWebhook(
  ctx: PagingContext,
  url: string,
): Promise<PagingWebhookRegistration> {
  const res = await ctx.api.post("/webhook_subscriptions", {
    body: {
      webhook_subscription: {
        type: "webhook_subscription",
        active: true,
        description: "Infrawrench: mirrors incidents and acknowledgements",
        delivery_method: { type: "http_delivery_method", url },
        events: WEBHOOK_EVENTS,
        filter: { type: "account_reference" },
      },
    },
  });
  const id = res?.webhook_subscription?.id;
  const secret = res?.webhook_subscription?.delivery_method?.secret;
  if (!id || !secret) {
    throw new PagerDutyApiError(
      502,
      "PagerDuty created the webhook but returned no signing secret",
    );
  }
  return { webhookId: id, secret };
}

export async function removeWebhook(ctx: PagingContext, webhookId: string): Promise<void> {
  try {
    await ctx.api.delete(`/webhook_subscriptions/${pathEncode(webhookId)}`);
  } catch (err) {
    // Already gone is what we wanted.
    if (statusOf(err) !== 404) throw err;
  }
}

interface WebhookEnvelope {
  event?: {
    event_type?: string;
    resource_type?: string;
    agent?: { summary?: string; email?: string } | null;
    data?: { id?: string; type?: string; incident_key?: string | null };
  };
}

/** Verify `X-PagerDuty-Signature` and read which incident (and dedup key) changed. */
export async function verifyWebhook(request: PagingWebhookRequest): Promise<PagingWebhookResult> {
  const header = request.headers["x-pagerduty-signature"] ?? "";
  const signatures = header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .map((s) => s.slice(3).toLowerCase());
  if (signatures.length === 0 || !request.secret) return rejectedPagingWebhook();
  const expected = bytesToHex(await hmacSha256(request.secret, request.body));
  if (!signatures.some((sig) => constantTimeEqual(sig, expected))) return rejectedPagingWebhook();

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(request.body);
  } catch {
    return { valid: true, incidentIds: [], acknowledgedDedupKeys: [], resolvedDedupKeys: [] };
  }
  const event = envelope.event;
  const data = event?.data;
  const result: PagingWebhookResult = {
    valid: true,
    incidentIds: [],
    acknowledgedDedupKeys: [],
    resolvedDedupKeys: [],
    actorEmail: event?.agent?.email ?? null,
  };
  // `pagey.ping` and service events carry no incident.
  if (event?.resource_type !== "incident" || !data?.id) return result;
  result.incidentIds.push(data.id);
  const key = data.incident_key;
  if (key) {
    if (event.event_type === "incident.acknowledged") result.acknowledgedDedupKeys.push(key);
    if (event.event_type === "incident.resolved") result.resolvedDedupKeys.push(key);
  }
  return result;
}
