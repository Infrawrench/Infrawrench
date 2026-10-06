/**
 * Paging providers (PagerDuty, incident.io, and any plugin that declares the
 * paging capability): the wire contract the settings editor, the incidents
 * panel, the phone and the CLI share.
 *
 * Three ideas live here and they are deliberately kept apart:
 *
 * - **Outbound events.** A `paging-provider` routing destination sends an
 *   Infrawrench alert to a provider target under a stable dedup key
 *   ({@link pagingDedupKey}), so the alert's own resolution and an Infrawrench
 *   acknowledgement reach the same upstream alert. Each send is a row the
 *   server keeps until the provider took it ({@link PagingEventRecord}).
 * - **On-call resolution.** A `provider-on-call` destination asks the provider
 *   who is on call right now and maps them to members by email.
 * - **Inbound incidents.** The provider's own incidents, mirrored into
 *   Infrawrench ({@link PagerIncidentRecord}) with acknowledge and resolve
 *   written back. These are *pager* incidents: not the incidents an org
 *   declares in Infrawrench (`incidents.ts`) and not a provider's public status
 *   page outage (`status-incidents.ts`), which is why every name here says
 *   "pager" or "paging".
 */
import type { CloudFetch } from "./fetch";

// --- Dedup keys ---

/**
 * The upstream dedup key for one Infrawrench alert lifecycle.
 *
 * Built from the org and the alert's lifecycle key (`probe:<id>`,
 * `metric-alert:<rule>:<resource>`, `incident:<id>`, `page:<source>:<key>`)
 * so the same condition always addresses the same upstream alert, and two orgs
 * sharing one PagerDuty account can never collide. Readable rather than hashed
 * on purpose: the key shows up in the provider's UI next to the alert, and
 * `iw:probe:…` explains itself where a digest would not. PagerDuty caps keys at
 * 255 characters, so the tail is trimmed while the readable prefix survives.
 */
export function pagingDedupKey(organizationId: string, lifecycleKey: string): string {
  const key = `iw:${organizationId}:${lifecycleKey}`;
  return key.length <= 255 ? key : key.slice(0, 255);
}

// --- Account-level configuration ---

export interface PagingProviderSettings {
  /** Mirror this account's incidents into Infrawrench. */
  inboundEnabled: boolean;
  /** True once a webhook (managed or pasted secret) is in place. */
  webhookConfigured: boolean;
  /**
   * The URL a manual webhook must point at, shown so the user can paste it into
   * the provider's dashboard. Null until inbound is enabled.
   */
  webhookUrl: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

/** One connected account whose plugin declares the paging capability. */
export interface PagingProviderAccount {
  accountId: string;
  displayName: string;
  pluginId: string;
  /** e.g. "Service", "Alert source". */
  targetLabel: string;
  targetDescription: string | null;
  /** Whether an Infrawrench acknowledgement can be written back as an event. */
  supportsAcknowledgeEvent: boolean;
  /** e.g. "Schedule or escalation policy"; null when the plugin has no on-call half. */
  onCallSourceLabel: string | null;
  /** Null when the plugin cannot list incidents. */
  incidents: { label: string; canAcknowledge: boolean; canResolve: boolean } | null;
  /** How webhooks are set up, or null when the plugin has none. */
  webhookMode: "managed" | "manual" | null;
  webhookSetupHelp: string | null;
  settings: PagingProviderSettings;
}

/** `GET /api/org/:orgId/paging-providers` (`org:settings:write`). */
export interface PagingProvidersResponse {
  accounts: PagingProviderAccount[];
}

/** `PUT /api/org/:orgId/paging-providers/:accountId/settings`. */
export interface PagingProviderSettingsInput {
  inboundEnabled: boolean;
  /**
   * For a `manual` webhook: the signing secret copied from the provider. Send
   * `null` to forget it; omit to keep the stored one.
   */
  webhookSecret?: string | null;
}

// --- Picker data for the routing editor ---

export interface PagingTargetOption {
  id: string;
  name: string;
  description: string | null;
}

export interface PagingOnCallSourceOption {
  id: string;
  name: string;
  kind: "schedule" | "escalation-policy";
}

/**
 * One account's pickers. Loaded from the provider live, so `error` carries a
 * failed listing per account rather than failing the whole response: one
 * revoked key must not hide every other provider from the editor.
 */
export interface PagingDestinationAccount {
  accountId: string;
  displayName: string;
  pluginId: string;
  targetLabel: string;
  onCallSourceLabel: string | null;
  targets: PagingTargetOption[];
  onCallSources: PagingOnCallSourceOption[];
  error: string | null;
}

/** `GET /api/org/:orgId/paging-providers/destinations` (`org:settings:write`). */
export interface PagingDestinationsResponse {
  accounts: PagingDestinationAccount[];
}

/** `GET /api/org/:orgId/paging-providers/:accountId/on-call/:sourceId` (`team:read`). */
export interface PagingOnCallNowResponse {
  people: Array<{
    name: string | null;
    email: string | null;
    /** The org member this person was matched to by email, or null. */
    memberUserId: string | null;
    until: string | null;
    level: number | null;
  }>;
}

// --- Outbound event log ---

export type PagingEventState = "triggered" | "acknowledged" | "resolved";

/**
 * One upstream alert Infrawrench opened, and where its lifecycle has got to.
 * `pendingAction` is set while a send is queued or being retried; `lastError`
 * says why the last attempt failed.
 */
export interface PagingEventRecord {
  id: string;
  accountId: string;
  targetId: string;
  dedupKey: string;
  trigger: string;
  title: string;
  state: PagingEventState;
  pendingAction: "trigger" | "acknowledge" | "resolve" | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

/** `GET /api/org/:orgId/paging-providers/events` (`org:settings:write`). */
export interface PagingEventsResponse {
  events: PagingEventRecord[];
}

// --- Inbound incidents ---

export type PagerIncidentStatus = "triggered" | "acknowledged" | "resolved";

export interface PagerIncidentRecord {
  /** Infrawrench's row id; what the acknowledge/resolve routes take. */
  id: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  /** The provider's id. */
  externalId: string;
  reference: string | null;
  title: string;
  status: PagerIncidentStatus;
  /** The provider's own status word, when it has a richer one. */
  statusLabel: string | null;
  urgency: string | null;
  url: string | null;
  serviceName: string | null;
  assignees: Array<{ name: string | null; email: string | null }>;
  createdAt: string;
  updatedAt: string | null;
  resolvedAt: string | null;
  /** True when an Infrawrench alert opened this incident. */
  fromInfrawrench: boolean;
  canAcknowledge: boolean;
  canResolve: boolean;
}

/** `GET /api/org/:orgId/paging-incidents` (`incidents:read`). */
export interface PagerIncidentsResponse {
  incidents: PagerIncidentRecord[];
}

export const PAGER_INCIDENT_STATUS_LABELS: Record<PagerIncidentStatus, string> = {
  triggered: "Triggered",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};

/**
 * Open incidents first (triggered before acknowledged), newest first within a
 * status. What every surface sorts by, so the phone and the panel agree on
 * which incident is "the top one".
 */
export function sortPagerIncidents(list: PagerIncidentRecord[]): PagerIncidentRecord[] {
  const rank: Record<PagerIncidentStatus, number> = { triggered: 0, acknowledged: 1, resolved: 2 };
  return [...list].sort(
    (a, b) => rank[a.status] - rank[b.status] || b.createdAt.localeCompare(a.createdAt),
  );
}

// --- Fetch helpers (mobile, CLI-shaped hosts) ---

/** `GET /api/org/:orgId/paging-incidents`. */
export async function fetchPagerIncidents(
  api: CloudFetch,
  orgId: string,
  options: { status?: "open" | "all" } = {},
): Promise<PagerIncidentsResponse> {
  const query = options.status === "all" ? "?status=all" : "";
  const res = await api.org<PagerIncidentsResponse>(orgId, `/paging-incidents${query}`);
  return res ?? { incidents: [] };
}

/** `POST /api/org/:orgId/paging-incidents/:id/{acknowledge|resolve}` (`incidents:write`). */
export async function actOnPagerIncident(
  api: CloudFetch,
  orgId: string,
  incidentId: string,
  action: "acknowledge" | "resolve",
): Promise<PagerIncidentRecord | null> {
  return api.org<PagerIncidentRecord>(
    orgId,
    `/paging-incidents/${encodeURIComponent(incidentId)}/${action}`,
    { method: "POST", body: "{}" },
  );
}
