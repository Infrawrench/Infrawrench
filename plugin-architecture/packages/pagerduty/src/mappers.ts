/**
 * PagerDuty response shapes (the fields this plugin reads, verified against
 * the REST OpenAPI document, 2026-10) and their mapping to `ResourceInstance`s
 * and to the paging capability's normalized incident.
 */
import type { PagingIncident, ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "pagerduty";

export interface PdRef {
  id?: string;
  type?: string;
  summary?: string;
  html_url?: string;
}

export interface PdUser extends PdRef {
  name?: string;
  email?: string;
  role?: string;
  time_zone?: string;
  job_title?: string;
  description?: string;
  teams?: PdRef[];
  invitation_sent?: boolean;
}

export interface PdIntegration extends PdRef {
  name?: string;
  integration_key?: string;
  vendor?: PdRef | null;
  created_at?: string;
}

export interface PdService extends PdRef {
  name?: string;
  description?: string | null;
  status?: string;
  created_at?: string;
  last_incident_timestamp?: string | null;
  auto_resolve_timeout?: number | null;
  acknowledgement_timeout?: number | null;
  alert_creation?: string;
  escalation_policy?: PdRef;
  teams?: PdRef[];
  integrations?: PdIntegration[];
  incident_urgency_rule?: { type?: string; urgency?: string };
}

export interface PdEscalationRule {
  id?: string;
  escalation_delay_in_minutes?: number;
  targets?: PdRef[];
}

export interface PdEscalationPolicy extends PdRef {
  name?: string;
  description?: string | null;
  num_loops?: number;
  on_call_handoff_notifications?: string;
  escalation_rules?: PdEscalationRule[];
  services?: PdRef[];
  teams?: PdRef[];
}

export interface PdScheduleEntry {
  start?: string;
  end?: string;
  user?: PdRef;
}

export interface PdSchedule extends PdRef {
  name?: string;
  description?: string | null;
  time_zone?: string;
  users?: PdRef[];
  teams?: PdRef[];
  escalation_policies?: PdRef[];
  final_schedule?: { rendered_schedule_entries?: PdScheduleEntry[] };
}

export interface PdOverride {
  id?: string;
  start?: string;
  end?: string;
  user?: PdRef;
}

export interface PdTeam extends PdRef {
  name?: string;
  description?: string | null;
  parent?: PdRef | null;
}

export interface PdAssignment {
  at?: string;
  assignee?: PdUser;
}

export interface PdIncident extends PdRef {
  incident_number?: number;
  title?: string;
  status?: "triggered" | "acknowledged" | "resolved";
  urgency?: string;
  created_at?: string;
  updated_at?: string;
  last_status_change_at?: string;
  resolved_at?: string | null;
  incident_key?: string | null;
  service?: PdService;
  escalation_policy?: PdRef;
  assignments?: PdAssignment[];
  acknowledgements?: Array<{ at?: string; acknowledger?: PdUser }>;
  priority?: (PdRef & { name?: string }) | null;
  teams?: PdRef[];
}

export interface PdMaintenanceWindow extends PdRef {
  sequence_number?: number;
  start_time?: string;
  end_time?: string;
  description?: string | null;
  services?: PdRef[];
  created_by?: PdRef;
}

export interface PdBusinessService extends PdRef {
  name?: string;
  description?: string | null;
  point_of_contact?: string | null;
  team?: PdRef | null;
}

export interface PdOrchestration extends PdRef {
  name?: string;
  description?: string | null;
  team?: PdRef | null;
  routes?: number;
  created_at?: string;
  updated_at?: string;
  integrations?: Array<{ id?: string; label?: string; parameters?: { routing_key?: string } }>;
}

export interface PdPriority extends PdRef {
  name?: string;
  description?: string;
}

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
  parentResourceId?: string,
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
    ...(parentResourceId ? { parentResourceId } : {}),
    createdAt: at,
    updatedAt: at,
  };
}

const names = (refs: PdRef[] | undefined): string =>
  (refs ?? [])
    .map((r) => r.summary ?? r.id ?? "")
    .filter(Boolean)
    .join(", ");

const ids = (refs: PdRef[] | undefined): string =>
  (refs ?? [])
    .map((r) => r.id ?? "")
    .filter(Boolean)
    .join(",");

/** `seconds` → whole minutes, or undefined when PagerDuty has it off (null). */
function minutes(seconds: number | null | undefined): number | undefined {
  return typeof seconds === "number" ? Math.round(seconds / 60) : undefined;
}

export function mapService(accountId: string, s: PdService): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    "pagerduty-service",
    id,
    s.name ?? id,
    clean({
      name: s.name,
      description: s.description ?? "",
      status: s.status,
      escalationPolicyId: s.escalation_policy?.id,
      escalationPolicyName: s.escalation_policy?.summary,
      autoResolveMinutes: minutes(s.auto_resolve_timeout),
      acknowledgementTimeoutMinutes: minutes(s.acknowledgement_timeout),
      alertCreation: s.alert_creation,
      urgency:
        s.incident_urgency_rule?.type === "constant"
          ? s.incident_urgency_rule.urgency
          : s.incident_urgency_rule?.type,
      teams: names(s.teams),
      teamIds: ids(s.teams),
      integrationCount: s.integrations?.length,
      lastIncidentAt: s.last_incident_timestamp ?? undefined,
      createdAt: s.created_at,
      htmlUrl: s.html_url,
    }),
  );
}

export function mapEscalationPolicy(accountId: string, p: PdEscalationPolicy): ResourceInstance {
  const id = p.id ?? "";
  const rules = p.escalation_rules ?? [];
  return instance(
    accountId,
    "pagerduty-escalation-policy",
    id,
    p.name ?? id,
    clean({
      name: p.name,
      description: p.description ?? "",
      numLoops: p.num_loops,
      levels: rules.length,
      firstLevelTargets: names(rules[0]?.targets),
      rulesJson: JSON.stringify(
        rules.map((r) => ({
          delay: r.escalation_delay_in_minutes,
          targets: (r.targets ?? []).map((t) => ({ id: t.id, type: t.type, name: t.summary })),
        })),
      ),
      services: names(p.services),
      teams: names(p.teams),
      htmlUrl: p.html_url,
    }),
  );
}

export function mapSchedule(accountId: string, s: PdSchedule): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    "pagerduty-schedule",
    id,
    s.name ?? id,
    clean({
      name: s.name,
      description: s.description ?? "",
      timeZone: s.time_zone,
      users: names(s.users),
      userCount: s.users?.length,
      escalationPolicies: names(s.escalation_policies),
      teams: names(s.teams),
      htmlUrl: s.html_url,
    }),
  );
}

export function mapTeam(accountId: string, t: PdTeam): ResourceInstance {
  const id = t.id ?? "";
  return instance(
    accountId,
    "pagerduty-team",
    id,
    t.name ?? id,
    clean({
      name: t.name,
      description: t.description ?? "",
      parentTeam: t.parent?.summary,
      htmlUrl: t.html_url,
    }),
  );
}

export function mapUser(accountId: string, u: PdUser): ResourceInstance {
  const id = u.id ?? "";
  return instance(
    accountId,
    "pagerduty-user",
    id,
    u.name ?? u.email ?? id,
    clean({
      name: u.name,
      email: u.email,
      role: u.role,
      timeZone: u.time_zone,
      jobTitle: u.job_title,
      teams: names(u.teams),
      invitationPending: u.invitation_sent,
      htmlUrl: u.html_url,
    }),
  );
}

export function incidentReference(i: PdIncident): string | null {
  return typeof i.incident_number === "number" ? `#${i.incident_number}` : null;
}

function assigneeNames(i: PdIncident): string {
  return (i.assignments ?? [])
    .map((a) => a.assignee?.name ?? a.assignee?.summary ?? "")
    .filter(Boolean)
    .join(", ");
}

export function mapIncident(accountId: string, i: PdIncident): ResourceInstance {
  const id = i.id ?? "";
  const ref = incidentReference(i);
  return instance(
    accountId,
    "pagerduty-incident",
    id,
    `${ref ? `${ref} ` : ""}${i.title ?? id}`,
    clean({
      title: i.title,
      number: i.incident_number,
      status: i.status,
      urgency: i.urgency,
      priority: i.priority?.name ?? i.priority?.summary,
      serviceId: i.service?.id,
      serviceName: i.service?.name ?? i.service?.summary,
      escalationPolicyName: i.escalation_policy?.summary,
      assignees: assigneeNames(i),
      incidentKey: i.incident_key ?? undefined,
      createdAt: i.created_at,
      lastStatusChangeAt: i.last_status_change_at,
      resolvedAt: i.resolved_at ?? undefined,
      htmlUrl: i.html_url,
    }),
    i.service?.id ? resourceId(accountId, "pagerduty-service", i.service.id) : undefined,
  );
}

export function mapMaintenanceWindow(accountId: string, w: PdMaintenanceWindow): ResourceInstance {
  const id = w.id ?? "";
  const now = Date.now();
  const start = w.start_time ? Date.parse(w.start_time) : NaN;
  const end = w.end_time ? Date.parse(w.end_time) : NaN;
  const state = now < start ? "upcoming" : now >= end ? "past" : "ongoing";
  return instance(
    accountId,
    "pagerduty-maintenance-window",
    id,
    w.description || `Maintenance #${w.sequence_number ?? id}`,
    clean({
      description: w.description ?? "",
      startTime: w.start_time,
      endTime: w.end_time,
      state,
      services: names(w.services),
      serviceIds: ids(w.services),
      createdBy: w.created_by?.summary,
      htmlUrl: w.html_url,
    }),
  );
}

export function mapBusinessService(accountId: string, b: PdBusinessService): ResourceInstance {
  const id = b.id ?? "";
  return instance(
    accountId,
    "pagerduty-business-service",
    id,
    b.name ?? id,
    clean({
      name: b.name,
      description: b.description ?? "",
      pointOfContact: b.point_of_contact ?? "",
      teamId: b.team?.id,
      teamName: b.team?.summary,
      htmlUrl: b.html_url,
    }),
  );
}

export function mapOrchestration(accountId: string, o: PdOrchestration): ResourceInstance {
  const id = o.id ?? "";
  return instance(
    accountId,
    "pagerduty-event-orchestration",
    id,
    o.name ?? id,
    clean({
      name: o.name,
      description: o.description ?? "",
      teamName: o.team?.summary ?? undefined,
      routes: o.routes,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    }),
  );
}

/** A PagerDuty incident in the paging capability's provider-neutral shape. */
export function toPagingIncident(i: PdIncident): PagingIncident {
  const assignees = (i.assignments ?? []).map((a) => ({
    name: a.assignee?.name ?? a.assignee?.summary ?? null,
    email: a.assignee?.email ?? null,
  }));
  // Once acknowledged, PagerDuty keeps the assignment but the acknowledger is
  // the person who took it; prefer them as the first name shown.
  const acker = i.acknowledgements?.[0]?.acknowledger;
  if (acker && !assignees.some((a) => a.email && a.email === acker.email)) {
    assignees.unshift({ name: acker.name ?? acker.summary ?? null, email: acker.email ?? null });
  }
  return {
    id: i.id ?? "",
    reference: incidentReference(i),
    title: i.title ?? i.summary ?? i.id ?? "",
    status: i.status ?? "triggered",
    urgency: i.urgency ?? null,
    url: i.html_url ?? null,
    createdAt: i.created_at ?? new Date().toISOString(),
    updatedAt: i.updated_at ?? i.last_status_change_at ?? null,
    resolvedAt: i.resolved_at ?? null,
    serviceName: i.service?.name ?? i.service?.summary ?? null,
    assignees,
    dedupKey: i.incident_key ?? null,
  };
}
