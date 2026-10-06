/**
 * Paging providers: a plugin whose provider pages people (PagerDuty,
 * incident.io, ...) declares `manifest.paging` and implements the optional
 * `PluginClient` methods below. The host's alert routing, on-call and incident
 * surfaces call only this contract; nothing in the host knows what a routing
 * key, an escalation policy or an alert source is.
 *
 * Four independent halves, each optional except the first:
 *
 * - **Outbound events.** {@link PluginClient.listPagingTargets} lists the places
 *   an alert can be sent (a PagerDuty service, an incident.io HTTP alert
 *   source); {@link PluginClient.sendPagingEvent} triggers, acknowledges or
 *   resolves one alert there under a host-chosen `dedupKey`. The plugin owns
 *   every secret involved (it looks up or creates the routing key, the source
 *   token), so the user picks a target by name and never pastes a key.
 * - **On-call resolution.** {@link PluginClient.listPagingOnCallSources} and
 *   {@link PluginClient.resolvePagingOnCall}: who is on call on a schedule or
 *   escalation policy right now, by email. The host maps emails to its own
 *   members; the plugin never sees the host's member list.
 * - **Inbound incidents.** {@link PluginClient.listPagingIncidents},
 *   {@link PluginClient.getPagingIncident} and
 *   {@link PluginClient.updatePagingIncident}: the provider's open incidents,
 *   mirrored by the host, with acknowledge and resolve written back.
 * - **Webhooks.** {@link PluginClient.registerPagingWebhook} subscribes a host
 *   URL when the provider has an API for that (`webhook.mode: "managed"`);
 *   otherwise the user pastes a signing secret (`"manual"`).
 *   {@link Plugin.verifyPagingWebhook} checks a delivery's signature and says
 *   which incidents to re-read and which of the host's dedup keys changed state.
 *   It lives on the Plugin because it needs no credentials, only the secret.
 *
 * Webhooks are treated as a nudge, never as the record: payloads can arrive out
 * of order, so the host re-reads each named incident through the API rather
 * than trusting the body. That is also the providers' own advice.
 */

/** How loud an event is. Plugins map this onto their own scale. */
export type PagingSeverity = "info" | "warning" | "critical";

export interface PagingCapabilityDeclaration {
  /** What one target is called in this provider, e.g. "Service", "Alert source". */
  targetLabel: string;
  /** One line under the target picker. */
  targetDescription?: string;
  /**
   * Whether `sendPagingEvent` can acknowledge. PagerDuty's Events API can; an
   * incident.io HTTP alert source only knows firing and resolved, so the host
   * skips the acknowledge leg rather than sending an event that would fail.
   */
  supportsAcknowledgeEvent: boolean;
  /** Present when the plugin implements on-call resolution. */
  onCall?: {
    /** e.g. "Schedule or escalation policy". */
    sourceLabel: string;
  };
  /** Present when the plugin implements the inbound incident methods. */
  incidents?: {
    /** e.g. "Incidents". */
    label: string;
    canAcknowledge: boolean;
    canResolve: boolean;
  };
  /** Present when the plugin implements `verifyPagingWebhook`. */
  webhook?: {
    /**
     * `managed`: the plugin subscribes the host URL itself through
     * `registerPagingWebhook`, and receives the signing secret back.
     * `manual`: the provider has no API for webhook endpoints, so the user
     * adds the URL in the provider's dashboard and pastes the signing secret.
     */
    mode: "managed" | "manual";
    /** For `manual`: where in the provider's dashboard the endpoint is added. */
    setupHelp?: string;
  };
}

/** One place an alert can be sent. */
export interface PagingTarget {
  id: string;
  name: string;
  /** Free text the picker shows beside the name (a team, a type). */
  description?: string;
  /** Deep link to the target in the provider's own UI. */
  url?: string | null;
}

export type PagingEventAction = "trigger" | "acknowledge" | "resolve";

export interface PagingEvent {
  action: PagingEventAction;
  /**
   * The host's stable key for this alert. The same key always addresses the
   * same upstream alert, which is what lets a later acknowledge or resolve find
   * the incident a trigger opened. At most 255 characters.
   */
  dedupKey: string;
  /** One line; the plugin truncates to the provider's limit. */
  summary: string;
  /** Longer text, when the provider has somewhere to put it. */
  body?: string;
  severity: PagingSeverity;
  /** What raised it, e.g. `infrawrench/probeAlerts`. */
  source: string;
  /** Deep link back into the host. */
  url?: string | null;
  /** Small structured facts shown beside the alert upstream. */
  details?: Record<string, string | number | boolean>;
  /** ISO time the alert was raised. */
  timestamp?: string;
}

export interface PagingEventResult {
  /** The key the provider recorded, normally `event.dedupKey`. */
  dedupKey: string;
  /** Link to the upstream alert or incident, when the provider returns one. */
  url?: string | null;
}

/** A schedule, escalation policy or path that can answer "who is on call". */
export interface PagingOnCallSource {
  id: string;
  name: string;
  /** Provider-neutral kind, used only to group the picker. */
  kind: "schedule" | "escalation-policy";
  description?: string;
}

export interface PagingOnCallPerson {
  /** Provider user id. */
  userId: string;
  name: string | null;
  /** The host matches people on this, case-insensitively. */
  email: string | null;
  /** When this person stops being on call, if the provider says. */
  until?: string | null;
  /** 1 for the first responder; higher levels for later escalation steps. */
  level?: number;
}

export type PagingIncidentStatus = "triggered" | "acknowledged" | "resolved";

/** A provider incident, normalized. */
export interface PagingIncident {
  id: string;
  /** Human reference, e.g. `#1234` or `INC-56`. */
  reference: string | null;
  title: string;
  status: PagingIncidentStatus;
  /** The provider's own status word, for display (e.g. "Investigating"). */
  statusLabel?: string | null;
  /** `high`/`low` on PagerDuty, a severity name on incident.io. */
  urgency?: string | null;
  url: string | null;
  createdAt: string;
  updatedAt?: string | null;
  resolvedAt?: string | null;
  /** The service, team or source it belongs to. */
  serviceName?: string | null;
  assignees: Array<{ name: string | null; email: string | null }>;
  /**
   * The dedup key of the alert that opened it, when it was opened by an event.
   * This is how the host recognises an incident its own trigger created.
   */
  dedupKey?: string | null;
}

export interface PagingIncidentQuery {
  /** Return incidents created or changed at or after this instant. */
  since: Date;
  /** Include resolved incidents changed since `since`. Defaults to true. */
  includeResolved?: boolean;
}

export interface PagingIncidentUpdate {
  action: "acknowledge" | "resolve";
  /**
   * The acting person's email, when the host knows it. Providers that record
   * who acted (PagerDuty's `From` header) use it, falling back to the account's
   * configured default user when the provider rejects it.
   */
  actorEmail?: string | null;
  /** Optional note recorded on the incident beside the change. */
  note?: string | null;
}

export interface PagingWebhookRegistration {
  /** Provider id of the subscription, for removal later. */
  webhookId: string;
  /** The signing secret, returned once by the provider. */
  secret: string;
}

/** One inbound delivery, as the host received it. */
export interface PagingWebhookRequest {
  /** Header names lowercased. */
  headers: Record<string, string>;
  /** The raw body, exactly as received: signatures are over these bytes. */
  body: string;
  /** The signing secret the host stored for this account. */
  secret: string;
  /** For timestamp tolerance checks. */
  now: Date;
}

export interface PagingWebhookResult {
  /** False when the signature did not verify; the host answers 401 and stops. */
  valid: boolean;
  /** Provider incident ids to re-read through `getPagingIncident`. */
  incidentIds: string[];
  /** Host dedup keys whose upstream alert a person acknowledged. */
  acknowledgedDedupKeys: string[];
  /** Host dedup keys whose upstream alert was resolved. */
  resolvedDedupKeys: string[];
  /**
   * Who acted, when the payload says. The host uses it to name the member
   * who acknowledged an escalating alert.
   */
  actorEmail?: string | null;
}

// --- Small helpers both providers' signature schemes need ---

function textBytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}

/**
 * HMAC-SHA256 through Web Crypto, which exists in Node 20+, Workers and every
 * browser context, so a plugin can verify signatures without `node:crypto`.
 */
export async function hmacSha256(
  key: string | Uint8Array<ArrayBuffer>,
  data: string,
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is not available in this runtime");
  const raw = typeof key === "string" ? textBytes(key) : key;
  const cryptoKey = await subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await subtle.sign("HMAC", cryptoKey, textBytes(data)));
}

/** Lowercase hex of some bytes. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Compare two strings in time that depends only on their length, so a
 * signature check does not leak how many leading characters matched.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** An empty, invalid webhook result: the shape a failed signature returns. */
export function rejectedPagingWebhook(): PagingWebhookResult {
  return { valid: false, incidentIds: [], acknowledgedDedupKeys: [], resolvedDedupKeys: [] };
}
