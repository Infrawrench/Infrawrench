/**
 * incident.io response shapes, named from the OpenAPI document, and their
 * mapping to `ResourceInstance`s and to the paging capability's normalized
 * incident.
 */
import type {
  PagingIncident,
  PagingIncidentStatus,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import type { components } from "./api-types.gen.js";

export const PLUGIN_ID = "incident-io";

type Schemas = components["schemas"];

export type IoUser = Schemas["UserWithRolesV2"];
/** What every user shape in the document has: list rows, assignees, team members. */
export type IoPerson = Schemas["UserV3"];
export type IoIncidentStatus = Schemas["IncidentStatusV1"];
export type IoSeverity = Schemas["SeverityV1"];
export type IoIncident = Schemas["IncidentV2"];
export type IoShift = Schemas["ScheduleEntryV2"];
export type IoSchedule = Schemas["ScheduleV2"];
export type IoEscalationPath = Schemas["EscalationPathV2"];
export type IoEscalation = Schemas["EscalationV2"];
export type IoAlertSource = Schemas["AlertSourceV2"];
export type IoAlertRoute = Schemas["AlertRouteSlimV2"];
export type IoCatalogType = Schemas["CatalogTypeV3"];
export type IoWorkflow = Schemas["WorkflowSlimV2"];
export type IoStatusPage = Schemas["StatusPageV2"];
export type IoMaintenanceWindow = Schemas["MaintenanceWindowV1"];
export type IoTeam = Schemas["TeamV3"];

type Fields = ResourceInstance["fields"];

function clean(fields: Record<string, string | number | boolean | null | undefined>): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export function resourceId(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
): ResourceInstance {
  const at = new Date().toISOString();
  return {
    id: resourceId(accountId, typeId, externalId),
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: at,
    updatedAt: at,
  };
}

const userName = (u: IoPerson | null | undefined): string => u?.name ?? u?.email ?? "";

export function leadOf(i: Partial<IoIncident>): IoPerson | null {
  return (
    (i.incident_role_assignments ?? []).find((a) => a.role?.role_type === "lead")?.assignee ?? null
  );
}

/** incident.io status category → the paging capability's three states. */
export function pagingStatusOf(category: string | undefined): PagingIncidentStatus {
  if (category === "triage") return "triggered";
  if (category === "live" || category === "paused") return "acknowledged";
  return "resolved";
}

export const OPEN_CATEGORIES = ["triage", "live", "paused"];

export function mapIncident(accountId: string, i: IoIncident): ResourceInstance {
  const id = i.id ?? "";
  const lead = leadOf(i);
  return instance(
    accountId,
    "incident-io-incident",
    id,
    `${i.reference ? `${i.reference} ` : ""}${i.name ?? id}`,
    clean({
      name: i.name,
      reference: i.reference,
      summary: i.summary ?? "",
      status: i.incident_status?.name,
      statusId: i.incident_status?.id,
      statusCategory: i.incident_status?.category,
      severity: i.severity?.name,
      severityId: i.severity?.id,
      incidentType: i.incident_type?.name,
      mode: i.mode,
      visibility: i.visibility,
      lead: lead ? userName(lead) : undefined,
      slackChannelUrl: i.slack_channel_url,
      callUrl: i.call_url,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      permalink: i.permalink,
    }),
  );
}

export function mapSchedule(accountId: string, s: IoSchedule): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    "incident-io-schedule",
    id,
    s.name ?? id,
    clean({
      name: s.name,
      timezone: s.timezone,
      onCallNow: (s.current_shifts ?? [])
        .map((sh) => userName(sh.user))
        .filter(Boolean)
        .join(", "),
      rotations: s.config?.rotations?.length,
      permalink: s.permalink,
    }),
  );
}

export function mapEscalationPath(accountId: string, p: IoEscalationPath): ResourceInstance {
  const id = p.id ?? "";
  return instance(
    accountId,
    "incident-io-escalation-path",
    id,
    p.name ?? id,
    clean({
      name: p.name,
      kind: p.kind,
      currentResponders: (p.current_responders ?? []).map(userName).filter(Boolean).join(", "),
      levels: (p.path ?? []).filter((n) => n.type === "level").length || undefined,
    }),
  );
}

export function mapEscalation(accountId: string, e: IoEscalation): ResourceInstance {
  const id = e.id ?? "";
  return instance(
    accountId,
    "incident-io-escalation",
    id,
    e.title ?? id,
    clean({
      title: e.title,
      status: e.status,
      priority: e.priority?.name,
      escalationPathId: e.escalation_path_id,
      alerts: (e.related_alerts ?? [])
        .map((a) => a.title ?? "")
        .filter(Boolean)
        .join(", "),
      incidents: (e.related_incidents ?? [])
        .map((r) => r.reference ?? r.name ?? "")
        .filter(Boolean)
        .join(", "),
      createdAt: e.created_at,
      updatedAt: e.updated_at,
    }),
  );
}

export function mapAlertSource(accountId: string, s: IoAlertSource): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    "incident-io-alert-source",
    id,
    s.name ?? id,
    clean({
      name: s.name,
      sourceType: s.source_type,
      autoResolveMinutes: s.auto_resolve_timeout_minutes,
      hasToken: Boolean(s.secret_token),
    }),
  );
}

export function mapAlertRoute(accountId: string, r: IoAlertRoute): ResourceInstance {
  const id = r.id ?? "";
  return instance(
    accountId,
    "incident-io-alert-route",
    id,
    r.name ?? id,
    clean({ name: r.name, enabled: r.enabled }),
  );
}

export function mapSeverity(accountId: string, s: IoSeverity): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    "incident-io-severity",
    id,
    s.name ?? id,
    clean({ name: s.name, rank: s.rank, description: s.description ?? "" }),
  );
}

export function mapIncidentStatus(accountId: string, s: IoIncidentStatus): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    "incident-io-status",
    id,
    s.name ?? id,
    clean({ name: s.name, category: s.category, rank: s.rank, description: s.description ?? "" }),
  );
}

export function mapCatalogType(accountId: string, t: IoCatalogType): ResourceInstance {
  const id = t.id ?? "";
  return instance(
    accountId,
    "incident-io-catalog-type",
    id,
    t.name ?? id,
    clean({
      name: t.name,
      description: t.description ?? "",
      typeName: t.type_name,
      entries: t.estimated_count,
      editable: t.is_editable,
      syncedFrom: t.registry_type,
      lastSyncedAt: t.last_synced_at,
    }),
  );
}

export function mapWorkflow(accountId: string, w: IoWorkflow): ResourceInstance {
  const id = w.id ?? "";
  return instance(
    accountId,
    "incident-io-workflow",
    id,
    w.name ?? id,
    clean({
      name: w.name,
      state: w.state,
      folder: w.folder,
      trigger: w.trigger?.label ?? w.trigger?.name,
      steps: (w.steps ?? [])
        .map((s) => s.label ?? "")
        .filter(Boolean)
        .join(" → "),
    }),
  );
}

export function mapStatusPage(accountId: string, p: IoStatusPage): ResourceInstance {
  const id = p.id ?? "";
  return instance(
    accountId,
    "incident-io-status-page",
    id,
    p.name ?? id,
    clean({ name: p.name, description: p.description ?? "", publicUrl: p.public_url }),
  );
}

export function mapMaintenanceWindow(accountId: string, w: IoMaintenanceWindow): ResourceInstance {
  const id = w.id ?? "";
  const now = Date.now();
  const start = w.start_at ? Date.parse(w.start_at) : NaN;
  const end = w.end_at ? Date.parse(w.end_at) : NaN;
  const state = now < start ? "upcoming" : now >= end ? "past" : "active";
  return instance(
    accountId,
    "incident-io-maintenance-window",
    id,
    w.name ?? id,
    clean({
      name: w.name,
      startAt: w.start_at,
      endAt: w.end_at,
      state,
      message: w.notification_message ?? "",
    }),
  );
}

export function mapUser(accountId: string, u: IoUser): ResourceInstance {
  const id = u.id ?? "";
  return instance(
    accountId,
    "incident-io-user",
    id,
    userName(u) || id,
    clean({
      name: u.name,
      email: u.email,
      role: u.base_role?.name ?? u.role,
      onCallSeat: u.seats?.on_call,
      responseSeat: u.seats?.response,
      active: u.is_active,
    }),
  );
}

export function mapTeam(accountId: string, t: IoTeam): ResourceInstance {
  const id = t.id ?? "";
  return instance(
    accountId,
    "incident-io-team",
    id,
    t.name ?? id,
    clean({ name: t.name, members: Array.isArray(t.members) ? t.members.length : undefined }),
  );
}

/** An incident.io incident in the paging capability's provider-neutral shape. */
export function toPagingIncident(i: Partial<IoIncident>): PagingIncident {
  const lead = leadOf(i);
  const status = pagingStatusOf(i.incident_status?.category);
  const resolvedAt =
    status === "resolved"
      ? ((i.incident_timestamp_values ?? []).find((t) =>
          /resolved|closed/i.test(t.incident_timestamp?.name ?? ""),
        )?.value?.value ??
        i.updated_at ??
        null)
      : null;
  return {
    id: i.id ?? "",
    reference: i.reference ?? null,
    title: i.name ?? i.id ?? "",
    status,
    statusLabel: i.incident_status?.name ?? null,
    urgency: i.severity?.name ?? null,
    url: i.permalink ?? null,
    createdAt: i.created_at ?? new Date().toISOString(),
    updatedAt: i.updated_at ?? null,
    resolvedAt,
    serviceName: i.incident_type?.name ?? null,
    assignees: lead ? [{ name: lead.name ?? null, email: lead.email ?? null }] : [],
    dedupKey: null,
  };
}
