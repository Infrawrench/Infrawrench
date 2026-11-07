/**
 * PagerDuty's response shapes (generated from the REST OpenAPI document) and
 * their mapping to `ResourceInstance`s and to the paging capability's
 * normalized incident. Every field stays optional here: a response is not
 * validated, so a mapper cannot rely on what the document calls required.
 */
import type { PagingIncident, ResourceInstance } from "@infrawrench/plugin-base";
import type { components } from "./api-types.rest.gen.js";

export const PLUGIN_ID = "pagerduty";

type Schemas = components["schemas"];

/** What a list of references is shown by. */
interface PdRef {
  id?: string;
  summary?: string | null;
}

/** A reference, or what `include[]` expanded it into, which is where the rest comes from. */
export interface PdExpandable extends PdRef {
  name?: string;
  email?: string;
}

export type PdUser = Partial<Schemas["User"]>;
export type PdService = Partial<Schemas["Service"]>;
export type PdEscalationPolicy = Partial<Schemas["EscalationPolicy"]>;
export type PdSchedule = Partial<Schemas["Schedule"]>;
export type PdTeam = Partial<Schemas["Team"]>;
export type PdIncident = Partial<Schemas["Incident"]>;
export type PdMaintenanceWindow = Partial<Schemas["MaintenanceWindow"]>;
export type PdAlert = Partial<Schemas["Alert"]>;

/** A service's integration, reference or expanded; only the expanded one has the key. */
export interface PdIntegration extends PdExpandable {
  type?: string;
  integration_key?: string;
}

/**
 * The document's team reference here is an id, a type and a link, so a team's name
 * comes from the team list. A `summary` PagerDuty does send still wins.
 */
export interface PdTeamReference {
  id?: string;
  summary?: string | null;
}

interface PdSummarizedTeam {
  team?: PdTeamReference | null;
}

export type PdBusinessService = Partial<Schemas["BusinessService"]> & PdSummarizedTeam;
export type PdOrchestration = Partial<Schemas["Orchestration"]> & PdSummarizedTeam;

/** Team names by id, for the references that do not carry one. */
export type TeamNames = ReadonlyMap<string, string>;

const NO_TEAM_NAMES: TeamNames = new Map();

export function teamNamesOf(teams: readonly PdTeam[]): TeamNames {
  const out = new Map<string, string>();
  for (const t of teams) if (t.id && t.name) out.set(t.id, t.name);
  return out;
}

function teamName(team: PdTeamReference | null | undefined, names: TeamNames): string | undefined {
  return team?.summary ?? (team?.id ? names.get(team.id) : undefined);
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

const names = (refs: readonly PdRef[] | undefined): string =>
  (refs ?? [])
    .map((r) => r.summary ?? r.id ?? "")
    .filter(Boolean)
    .join(", ");

const ids = (refs: readonly PdRef[] | undefined): string =>
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

export function mapTeam(
  accountId: string,
  t: PdTeam,
  names: TeamNames = NO_TEAM_NAMES,
): ResourceInstance {
  const id = t.id ?? "";
  return instance(
    accountId,
    "pagerduty-team",
    id,
    t.name ?? id,
    clean({
      name: t.name,
      description: t.description ?? "",
      parentTeam: teamName(t.parent, names),
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
    .map((a) => {
      const assignee: PdExpandable | undefined = a.assignee;
      return assignee?.name ?? assignee?.summary ?? "";
    })
    .filter(Boolean)
    .join(", ");
}

export function mapIncident(accountId: string, i: PdIncident): ResourceInstance {
  const id = i.id ?? "";
  const ref = incidentReference(i);
  const service: PdExpandable | undefined = i.service;
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
      serviceId: service?.id,
      serviceName: service?.name ?? service?.summary,
      escalationPolicyName: i.escalation_policy?.summary,
      assignees: assigneeNames(i),
      incidentKey: i.incident_key ?? undefined,
      createdAt: i.created_at,
      lastStatusChangeAt: i.last_status_change_at,
      resolvedAt: i.resolved_at ?? undefined,
      htmlUrl: i.html_url,
    }),
    service?.id ? resourceId(accountId, "pagerduty-service", service.id) : undefined,
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

export function mapBusinessService(
  accountId: string,
  b: PdBusinessService,
  names: TeamNames = NO_TEAM_NAMES,
): ResourceInstance {
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
      teamName: teamName(b.team, names),
      htmlUrl: b.html_url,
    }),
  );
}

export function mapOrchestration(
  accountId: string,
  o: PdOrchestration,
  names: TeamNames = NO_TEAM_NAMES,
): ResourceInstance {
  const id = o.id ?? "";
  return instance(
    accountId,
    "pagerduty-event-orchestration",
    id,
    o.name ?? id,
    clean({
      name: o.name,
      description: o.description ?? "",
      teamName: teamName(o.team, names),
      routes: o.routes,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    }),
  );
}

/** A PagerDuty incident in the paging capability's provider-neutral shape. */
export function toPagingIncident(i: PdIncident): PagingIncident {
  const assignees = (i.assignments ?? []).map((a) => {
    const assignee: PdExpandable | undefined = a.assignee;
    return { name: assignee?.name ?? assignee?.summary ?? null, email: assignee?.email ?? null };
  });
  // Once acknowledged, PagerDuty keeps the assignment but the acknowledger is
  // the person who took it; prefer them as the first name shown.
  const acker: PdExpandable | undefined = i.acknowledgements?.[0]?.acknowledger;
  if (acker && !assignees.some((a) => a.email && a.email === acker.email)) {
    assignees.unshift({ name: acker.name ?? acker.summary ?? null, email: acker.email ?? null });
  }
  const service: PdExpandable | undefined = i.service;
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
    serviceName: service?.name ?? service?.summary ?? null,
    assignees,
    dedupKey: i.incident_key ?? null,
  };
}
