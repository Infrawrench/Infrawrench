import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { ApiBody, NoSlashString, PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PagingEvent,
  PagingEventResult,
  PagingIncident,
  PagingIncidentQuery,
  PagingIncidentUpdate,
  PagingOnCallPerson,
  PagingOnCallSource,
  PagingTarget,
  PagingWebhookRegistration,
  PluginClient,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf, pathEncode, rethrowIncompleteList } from "@infrawrench/plugin-base";
import type { PagerDutyApi, PagerDutyRegion, PagerDutyTransport } from "./api.js";
import { PagerDutyApiError, createPagerDutyApi, createPagerDutyEvents, statusOf } from "./api.js";
import type { operations } from "./api-types.rest.gen.js";
import { isPagerDutyOAuth } from "./oauth.js";
import type {
  PdEscalationPolicy,
  PdAlert,
  PdBusinessService,
  PdExpandable,
  PdIncident,
  PdIntegration,
  PdOrchestration,
  PdTeam,
  PdTeamReference,
  PdUser,
  TeamNames,
} from "./mappers.js";
import {
  incidentReference,
  mapBusinessService,
  mapEscalationPolicy,
  mapIncident,
  mapMaintenanceWindow,
  mapOrchestration,
  mapSchedule,
  mapService,
  mapTeam,
  mapUser,
  teamNamesOf,
} from "./mappers.js";
import { rangeOrDefault, serviceAnalytics, seriesFromRows } from "./metrics.js";
import type { PagingContext } from "./paging.js";
import {
  getIncident,
  listIncidents,
  listOnCallSources,
  listTargets,
  orchestrationRoutingKey,
  registerWebhook,
  removeWebhook,
  resolveOnCall,
  sendPagingEvent,
  serviceRoutingKey,
  updateIncident,
  withFrom,
} from "./paging.js";
import type {
  AlertRow,
  IncidentRow,
  IntegrationRow,
  NoteRow,
  OnCallRow,
  Option,
  OverrideRow,
  ShiftRow,
} from "./render.js";
import {
  ACTIONS,
  ALERTS_KEY,
  COMMANDS,
  INTEGRATIONS_KEY,
  NOTES_KEY,
  ONCALL_KEY,
  OPEN_INCIDENTS_KEY,
  OVERRIDES_KEY,
  POLICIES_KEY,
  PRIORITIES_KEY,
  SHIFTS_KEY,
  SUMMARY_KEY,
  USERS_KEY,
  renderPagerDutyDetail,
  renderPagerDutySidebar,
} from "./render.js";
import { URGENCIES } from "./resource-types.js";

const CACHE_MS = 60_000;
/** A detail page's table stops here, showing what it has, rather than spend 100 requests. */
const DETAIL_MAX_PAGES = 20;
/** Resolved incidents older than this are not listed as resources. */
const RESOLVED_WINDOW_MS = 7 * 24 * 3600_000;

/** A read kept for `CACHE_MS`, unless it failed: one transient error must not answer for a minute. */
class CachedRead<T> {
  private entry: { at: number; value: Promise<T> } | undefined;
  private readonly read: () => Promise<T>;

  constructor(read: () => Promise<T>) {
    this.read = read;
  }

  get(): Promise<T> {
    if (this.entry && Date.now() - this.entry.at < CACHE_MS) return this.entry.value;
    const value = this.read();
    this.entry = { at: Date.now(), value };
    value.catch(() => {
      if (this.entry?.value === value) this.entry = undefined;
    });
    return value;
  }

  clear(): void {
    this.entry = undefined;
  }
}

const trimmed = (fields: Record<string, string>, key: string): string => (fields[key] ?? "").trim();

/** Minutes typed in a form → seconds, or null to turn the timeout off. */
function seconds(fields: Record<string, string>, key: string): number | null | undefined {
  if (!(key in fields)) return undefined;
  const raw = trimmed(fields, key);
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`"${key}" must be a number of minutes.`);
  return Math.round(n * 60);
}

/** Parse a prompt form's values (the host sends them JSON-encoded in `args[0]`). */
export function parsePromptValues(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string" || !first) return {};
  try {
    const parsed: unknown = JSON.parse(first);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")]));
  } catch {
    return {};
  }
}

/** A policy-picker value: a JSON array of ids, tolerating a comma list. */
function parseIdList(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // fall through
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ref = <const Type extends string>(id: string, type: Type) => ({ id, type });

type PdEscalationRule = NonNullable<PdEscalationPolicy["escalation_rules"]>[number];

/** An id read back for a write. A blank one must stop the write, not reach PagerDuty. */
function requireId(id: string | undefined, what: string): string {
  if (!id) throw new PagerDutyApiError(502, `PagerDuty returned ${what} that has no id`);
  return id;
}

/** A rule as it was read, to send back with the rest of its policy. */
function ruleToKeep(rule: PdEscalationRule): PdEscalationRule {
  const strategy = rule.escalation_rule_assignment_strategy;
  const name = typeof strategy === "string" ? strategy : strategy?.type;
  return {
    ...(rule.id ? { id: rule.id } : {}),
    escalation_delay_in_minutes: rule.escalation_delay_in_minutes,
    targets: (rule.targets ?? []).map((t) =>
      ref(requireId(t.id, "an escalation target"), t.type ?? "user_reference"),
    ),
    // Sent in the form it was read, because the document's schema says a string and its
    // example an object. Assigning to everyone is what a rule with no strategy does, so
    // it stays out, as it always has: a plan without round robin may refuse the field.
    ...(strategy && name !== "assign_to_everyone"
      ? { escalation_rule_assignment_strategy: strategy }
      : {}),
  };
}

/** What an incident update can set; the type is added when it is sent. */
type IncidentChange = Omit<ApiBody<operations["updateIncident"]>["incident"], "type">;

export class PagerDutyClient implements PluginClient {
  private readonly api: PagerDutyApi;
  private readonly fromEmail: string;
  private readonly paging: PagingContext;
  private readonly userRead = new CachedRead<PdUser[]>(() =>
    this.api.getAll("/users", "users", { query: { "include[]": ["teams"] } }),
  );
  private readonly policyRead = new CachedRead<PdEscalationPolicy[]>(() =>
    this.api.getAll("/escalation_policies", "escalation_policies", {
      query: { "include[]": ["services", "teams"], sort_by: "name" },
    }),
  );
  // The pickers' reads are their own: part of a very long list is fine for them, and
  // must never answer for the inventory, which has to fail instead.
  private readonly userPickerRead = new CachedRead<PdUser[]>(() =>
    this.api.getAll("/users", "users", { partial: true }),
  );
  private readonly policyPickerRead = new CachedRead<PdEscalationPolicy[]>(() =>
    this.api.getAll("/escalation_policies", "escalation_policies", {
      query: { sort_by: "name" },
      partial: true,
    }),
  );

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) {
      throw new Error(
        "PagerDuty plugin: enter a REST API key (Integrations, API Access Keys in PagerDuty)",
      );
    }
    const region: PagerDutyRegion = (credentials["region"] ?? "").trim() === "eu" ? "eu" : "us";
    const caCert = credentials["caCert"] ?? "";
    this.fromEmail = (credentials["fromEmail"] ?? "").trim();
    const transport: PagerDutyTransport = {
      apiKey,
      ...(isPagerDutyOAuth(credentials) ? { bearer: true } : {}),
      region,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.api = createPagerDutyApi(transport);
    this.paging = {
      api: this.api,
      events: createPagerDutyEvents(transport),
      fromEmail: this.fromEmail,
      routingKeys: new Map(),
    };
  }

  private readonly teamNameRead = new CachedRead<PdTeam[]>(() =>
    this.api.getAll("/teams", "teams", { partial: true }),
  );

  private invalidate(): void {
    this.userRead.clear();
    this.policyRead.clear();
    this.userPickerRead.clear();
    this.policyPickerRead.clear();
    this.teamNameRead.clear();
  }

  /** Names for team references that came without one; no request when none did. */
  private async teamNames(
    refs: readonly (PdTeamReference | null | undefined)[],
  ): Promise<TeamNames> {
    if (!refs.some((t) => t?.id && !t.summary)) return new Map();
    const teams = await this.teamNameRead.get().catch((err: unknown): PdTeam[] => {
      rethrowIncompleteList(err);
      // A name is all this adds: a key or a plan that cannot read teams loses only that.
      return [];
    });
    return teamNamesOf(teams);
  }

  private async userOptions(): Promise<Option[]> {
    return (await this.userPickerRead.get()).map((u) => ({
      id: u.id ?? "",
      name: u.name ?? u.email ?? u.id ?? "",
      ...(u.email ? { description: u.email } : {}),
    }));
  }

  private async policyOptions(): Promise<Option[]> {
    return (await this.policyPickerRead.get()).map((p) => ({
      id: p.id ?? "",
      name: p.name ?? p.id ?? "",
    }));
  }

  private async priorityOptions(): Promise<Option[]> {
    try {
      const priorities = await this.api.getAll("/priorities", "priorities");
      return priorities.map((p) => ({
        id: p.id ?? "",
        name: p.name ?? p.id ?? "",
        ...(p.description ? { description: p.description } : {}),
      }));
    } catch {
      // Priorities are a plan feature; without them the picker is just absent.
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "pagerduty-service":
          return (
            await this.api.getAll("/services", "services", {
              query: { "include[]": ["integrations", "teams"], sort_by: "name" },
            })
          ).map((s) => mapService(accountId, s));
        case "pagerduty-escalation-policy":
          return (await this.policyRead.get()).map((p) => mapEscalationPolicy(accountId, p));
        case "pagerduty-schedule":
          return (await this.api.getAll("/schedules", "schedules")).map((s) =>
            mapSchedule(accountId, s),
          );
        case "pagerduty-team": {
          const teams = await this.api.getAll("/teams", "teams").catch((err: unknown): PdTeam[] => {
            // The document's 402: this account does not have the teams ability, so none to list.
            if (statusOf(err) === 402) return [];
            throw err;
          });
          const names = teamNamesOf(teams);
          return teams.map((t) => mapTeam(accountId, t, names));
        }
        case "pagerduty-user":
          return (await this.userRead.get()).map((u) => mapUser(accountId, u));
        case "pagerduty-incident": {
          const [open, resolved] = await Promise.all([
            this.api.getAll("/incidents", "incidents", {
              query: {
                "statuses[]": ["triggered", "acknowledged"],
                date_range: "all",
                "include[]": ["assignees"],
              },
            }),
            this.api.getAll("/incidents", "incidents", {
              query: {
                "statuses[]": ["resolved"],
                since: new Date(Date.now() - RESOLVED_WINDOW_MS).toISOString(),
                until: new Date().toISOString(),
                "include[]": ["assignees"],
              },
            }),
          ]);
          return [...open, ...resolved].map((i) => mapIncident(accountId, i));
        }
        case "pagerduty-maintenance-window":
          return (
            await this.api.getAll("/maintenance_windows", "maintenance_windows", {
              query: { filter: "open" },
            })
          ).map((w) => mapMaintenanceWindow(accountId, w));
        case "pagerduty-business-service": {
          const services: PdBusinessService[] = await this.api.getAll(
            "/business_services",
            "business_services",
          );
          const names = await this.teamNames(services.map((b) => b.team));
          return services.map((b) => mapBusinessService(accountId, b, names));
        }
        case "pagerduty-event-orchestration": {
          const orchestrations = await this.api
            .getAll("/event_orchestrations", "orchestrations")
            .catch((err: unknown): PdOrchestration[] => {
              // Event orchestration is not on every plan; a 403 means none to list.
              if (statusOf(err) === 403) return [];
              throw err;
            });
          const names = await this.teamNames(orchestrations.map((o) => o.team));
          return orchestrations.map((o) => mapOrchestration(accountId, o, names));
        }
        default:
          throw new Error(`PagerDuty plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Single reads (with what the detail page shows)
  // -------------------------------------------------------------------------

  private async onCallRows(escalationPolicyId: string): Promise<OnCallRow[]> {
    const oncalls = await this.api.getAll("/oncalls", "oncalls", {
      query: {
        "escalation_policy_ids[]": [escalationPolicyId],
        "include[]": ["users"],
        earliest: true,
      },
    });
    return oncalls
      .map((o) => {
        const user: PdExpandable | undefined = o.user;
        return {
          level: o.escalation_level ?? 1,
          name: user?.name ?? user?.summary ?? "",
          email: user?.email ?? "",
          schedule: o.schedule?.summary ?? "",
          until: o.end ?? "",
        };
      })
      .sort((a, b) => a.level - b.level);
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      const id = pathEncode(ext);
      switch (typeId) {
        case "pagerduty-service": {
          const res = await this.api.get(`/services/${id}`, {
            query: { "include[]": ["integrations", "teams"] },
          });
          if (!res?.service) throw new PagerDutyApiError(404, "PagerDuty service not found");
          const r = mapService(accountId, res.service);
          const s = res.service;
          const [oncall, summary, open, policies, priorities] = await Promise.all([
            s.escalation_policy?.id
              ? this.onCallRows(s.escalation_policy.id).catch((): OnCallRow[] => [])
              : Promise.resolve<OnCallRow[]>([]),
            serviceAnalytics(this.api, ext, rangeOrDefault(undefined))
              .then((rows) => rows[0])
              .catch(() => undefined),
            this.api
              .getAll("/incidents", "incidents", {
                query: {
                  "service_ids[]": [ext],
                  "statuses[]": ["triggered", "acknowledged"],
                  date_range: "all",
                },
                maxPages: DETAIL_MAX_PAGES,
                partial: true,
              })
              .catch((): PdIncident[] => []),
            this.policyOptions().catch((): Option[] => []),
            this.priorityOptions(),
          ]);
          const integrations: IntegrationRow[] = (s.integrations ?? []).map((i: PdIntegration) => ({
            id: i.id ?? "",
            name: i.name ?? i.summary ?? "",
            type: i.type ?? "",
          }));
          const incidents: IncidentRow[] = open.map((i) => ({
            id: i.id ?? "",
            ref: incidentReference(i) ?? "",
            title: i.title ?? "",
            status: i.status ?? "",
            urgency: i.urgency ?? "",
            at: i.created_at ?? "",
          }));
          r.fields[ONCALL_KEY] = JSON.stringify(oncall);
          if (summary) r.fields[SUMMARY_KEY] = JSON.stringify(summary);
          r.fields[OPEN_INCIDENTS_KEY] = JSON.stringify(incidents);
          r.fields[INTEGRATIONS_KEY] = JSON.stringify(integrations);
          r.fields[POLICIES_KEY] = JSON.stringify(policies);
          r.fields[PRIORITIES_KEY] = JSON.stringify(priorities);
          return r;
        }
        case "pagerduty-escalation-policy": {
          const res = await this.api.get(`/escalation_policies/${id}`, {
            query: { "include[]": ["services", "teams", "targets"] },
          });
          if (!res?.escalation_policy) {
            throw new PagerDutyApiError(404, "PagerDuty escalation policy not found");
          }
          const r = mapEscalationPolicy(accountId, res.escalation_policy);
          const oncall = await this.onCallRows(ext).catch((): OnCallRow[] => []);
          r.fields[ONCALL_KEY] = JSON.stringify(oncall);
          return r;
        }
        case "pagerduty-schedule": {
          const now = Date.now();
          const since = new Date(now).toISOString();
          const res = await this.api.get(`/schedules/${id}`, {
            query: { since, until: new Date(now + 7 * 24 * 3600_000).toISOString() },
          });
          if (!res?.schedule) throw new PagerDutyApiError(404, "PagerDuty schedule not found");
          const r = mapSchedule(accountId, res.schedule);
          const shifts: ShiftRow[] = (
            res.schedule.final_schedule?.rendered_schedule_entries ?? []
          ).map((e) => ({ name: e.user?.summary ?? "", start: e.start ?? "", end: e.end ?? "" }));
          const [overrides, users] = await Promise.all([
            this.api
              .get(`/schedules/${id}/overrides`, {
                query: {
                  since,
                  until: new Date(now + 30 * 24 * 3600_000).toISOString(),
                  editable: true,
                },
              })
              .catch(() => ({ overrides: [] })),
            this.userOptions().catch((): Option[] => []),
          ]);
          const overrideRows: OverrideRow[] = (overrides?.overrides ?? []).map((o) => ({
            id: o.id ?? "",
            name: o.user?.summary ?? "",
            start: o.start ?? "",
            end: o.end ?? "",
          }));
          r.fields[SHIFTS_KEY] = JSON.stringify(shifts);
          r.fields[OVERRIDES_KEY] = JSON.stringify(overrideRows);
          r.fields[USERS_KEY] = JSON.stringify(users);
          return r;
        }
        case "pagerduty-team": {
          const res = await this.api.get(`/teams/${id}`);
          if (!res?.team) throw new PagerDutyApiError(404, "PagerDuty team not found");
          return mapTeam(accountId, res.team, await this.teamNames([res.team.parent]));
        }
        case "pagerduty-user": {
          const res = await this.api.get(`/users/${id}`, { query: { "include[]": ["teams"] } });
          if (!res?.user) throw new PagerDutyApiError(404, "PagerDuty user not found");
          return mapUser(accountId, res.user);
        }
        case "pagerduty-incident": {
          const res = await this.api.get(`/incidents/${id}`, {
            query: { "include[]": ["assignees", "services", "priorities"] },
          });
          if (!res?.incident) throw new PagerDutyApiError(404, "PagerDuty incident not found");
          const r = mapIncident(accountId, res.incident);
          const [notes, alerts, users, policies, priorities] = await Promise.all([
            this.api.get(`/incidents/${id}/notes`).catch(() => ({ notes: [] })),
            this.api
              .getAll(`/incidents/${id}/alerts`, "alerts", {
                query: { sort_by: "created_at:desc" },
                maxPages: DETAIL_MAX_PAGES,
                partial: true,
              })
              .catch((): PdAlert[] => []),
            this.userOptions().catch((): Option[] => []),
            this.policyOptions().catch((): Option[] => []),
            this.priorityOptions(),
          ]);
          const noteRows: NoteRow[] = (notes?.notes ?? []).map((n) => ({
            at: n.created_at ?? "",
            who: n.user?.summary ?? "",
            content: n.content ?? "",
          }));
          const alertRows: AlertRow[] = alerts.map((a) => ({
            key: a.alert_key ?? "",
            status: a.status ?? "",
            summary: a.summary ?? "",
            at: a.created_at ?? "",
          }));
          r.fields[NOTES_KEY] = JSON.stringify(noteRows);
          r.fields[ALERTS_KEY] = JSON.stringify(alertRows);
          r.fields[USERS_KEY] = JSON.stringify(users);
          r.fields[POLICIES_KEY] = JSON.stringify(policies);
          r.fields[PRIORITIES_KEY] = JSON.stringify(priorities);
          return r;
        }
        case "pagerduty-maintenance-window": {
          const res = await this.api.get(`/maintenance_windows/${id}`, {
            query: { "include[]": ["services"] },
          });
          if (!res?.maintenance_window) {
            throw new PagerDutyApiError(404, "PagerDuty maintenance window not found");
          }
          return mapMaintenanceWindow(accountId, res.maintenance_window);
        }
        case "pagerduty-business-service": {
          const res = await this.api.get(`/business_services/${id}`);
          if (!res?.business_service) {
            throw new PagerDutyApiError(404, "PagerDuty business service not found");
          }
          const service: PdBusinessService = res.business_service;
          return mapBusinessService(accountId, service, await this.teamNames([service.team]));
        }
        case "pagerduty-event-orchestration": {
          const res = await this.api.get(`/event_orchestrations/${id}`);
          if (!res?.orchestration) {
            throw new PagerDutyApiError(404, "PagerDuty event orchestration not found");
          }
          const orchestration: PdOrchestration = res.orchestration;
          return mapOrchestration(
            accountId,
            orchestration,
            await this.teamNames([orchestration.team]),
          );
        }
        default:
          throw new Error(`PagerDuty plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      switch (`${typeId}/${outputKey}`) {
        case "pagerduty-service/serviceId":
        case "pagerduty-escalation-policy/escalationPolicyId":
        case "pagerduty-schedule/scheduleId":
        case "pagerduty-team/teamId":
        case "pagerduty-business-service/businessServiceId":
        case "pagerduty-event-orchestration/orchestrationId":
          return ext;
        case "pagerduty-service/eventsRoutingKey":
          // Read only: an output read must not create an integration.
          return serviceRoutingKey(this.api, ext, { create: false });
        case "pagerduty-event-orchestration/routingKey":
          return orchestrationRoutingKey(this.api, ext);
        default:
          throw new Error(
            `PagerDuty plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
          );
      }
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "pagerduty-service") return [];
      const rows = await serviceAnalytics(
        this.api,
        externalIdOf(resourceId),
        rangeOrDefault(timeRange),
        "day",
      );
      return seriesFromRows(rows);
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      const toSelect = (options: Option[]): SelectOption[] =>
        options.map((o) => ({
          id: o.id,
          label: o.name,
          ...(o.description ? { description: o.description } : {}),
        }));
      switch (typeId) {
        case "pagerduty-service":
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "checkout-api",
              },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "escalationPolicyId",
                label: "Escalation policy",
                kind: "select",
                required: true,
                options: toSelect(await this.policyOptions()),
                description: "Who is paged when this service opens an incident.",
              },
              {
                key: "urgency",
                label: "Incident urgency",
                kind: "select",
                required: false,
                defaultValue: "high",
                options: URGENCIES.map((u) => ({ id: u, label: u === "high" ? "High" : "Low" })),
              },
              {
                key: "autoResolveMinutes",
                label: "Auto-resolve after (minutes)",
                kind: "number",
                required: false,
                defaultValue: "240",
                description: "Leave empty to never auto-resolve.",
              },
              {
                key: "acknowledgementTimeoutMinutes",
                label: "Re-trigger after acknowledgement (minutes)",
                kind: "number",
                required: false,
                defaultValue: "30",
              },
            ],
          };
        case "pagerduty-escalation-policy": {
          const [users, schedules] = await Promise.all([
            this.userOptions(),
            this.api.getAll("/schedules", "schedules", { partial: true }),
          ]);
          const targets: SelectOption[] = [
            ...schedules.map((s) => ({
              id: `schedule_reference:${s.id}`,
              label: s.name ?? s.id ?? "",
              description: "Schedule",
            })),
            ...users.map((u) => ({
              id: `user_reference:${u.id}`,
              label: u.name,
              description: u.description ?? "Person",
            })),
          ];
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "targets",
                label: "First level notifies",
                kind: "policy-picker",
                required: true,
                options: targets,
                description: "Schedules and people paged first. Add later levels in PagerDuty.",
              },
              {
                key: "delayMinutes",
                label: "Escalate after (minutes)",
                kind: "number",
                required: false,
                defaultValue: "30",
              },
              {
                key: "numLoops",
                label: "Repeat times",
                kind: "number",
                required: false,
                defaultValue: "0",
                minValue: 0,
                maxValue: 9,
              },
            ],
          };
        }
        case "pagerduty-team":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case "pagerduty-maintenance-window": {
          const services = await this.api.getAll("/services", "services", {
            query: { sort_by: "name" },
            partial: true,
          });
          return {
            fields: [
              {
                key: "services",
                label: "Services",
                kind: "policy-picker",
                required: true,
                options: services.map((s) => ({ id: s.id ?? "", label: s.name ?? s.id ?? "" })),
              },
              { key: "startTime", label: "Starts", kind: "datetime", required: true },
              { key: "endTime", label: "Ends", kind: "datetime", required: true },
              {
                key: "description",
                label: "Description",
                kind: "text",
                required: false,
                placeholder: "Database failover drill",
              },
            ],
          };
        }
        case "pagerduty-business-service": {
          const teams = await this.api
            .getAll("/teams", "teams", { partial: true })
            .catch((): PdTeam[] => []);
          const fields: CreateFieldConfig[] = [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "Checkout" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "pointOfContact",
              label: "Point of contact",
              kind: "text",
              required: false,
              placeholder: "#checkout-team or a phone number",
            },
          ];
          if (teams.length > 0) {
            fields.push({
              key: "teamId",
              label: "Owning team",
              kind: "select",
              required: false,
              options: teams.map((t) => ({ id: t.id ?? "", label: t.name ?? t.id ?? "" })),
            });
          }
          return { fields };
        }
        default:
          throw new Error(`PagerDuty plugin: creating "${typeId}" is not supported`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      this.invalidate();
      switch (typeId) {
        case "pagerduty-service": {
          const policy = trimmed(fields, "escalationPolicyId");
          if (!trimmed(fields, "name") || !policy) {
            throw new Error("A service needs a name and an escalation policy.");
          }
          const urgency = trimmed(fields, "urgency") || "high";
          const description = trimmed(fields, "description");
          const res = await this.api.post("/services", {
            body: {
              service: {
                type: "service",
                name: trimmed(fields, "name"),
                ...(description ? { description } : {}),
                escalation_policy: ref(policy, "escalation_policy_reference"),
                auto_resolve_timeout: seconds(fields, "autoResolveMinutes") ?? null,
                acknowledgement_timeout: seconds(fields, "acknowledgementTimeoutMinutes") ?? null,
                alert_creation: "create_alerts_and_incidents",
                incident_urgency_rule: { type: "constant", urgency },
              },
            },
          });
          if (!res?.service) throw new Error("PagerDuty did not return the new service.");
          return mapService(accountId, res.service);
        }
        case "pagerduty-escalation-policy": {
          const targets = parseIdList(trimmed(fields, "targets")).map((t) => {
            const [type, id] = t.split(":");
            return ref(id ?? "", type ?? "user_reference");
          });
          if (!trimmed(fields, "name") || targets.length === 0) {
            throw new Error("An escalation policy needs a name and someone to notify.");
          }
          const description = trimmed(fields, "description");
          const res = await this.api.post("/escalation_policies", {
            body: {
              escalation_policy: {
                type: "escalation_policy",
                name: trimmed(fields, "name"),
                ...(description ? { description } : {}),
                num_loops: Number(trimmed(fields, "numLoops") || 0),
                escalation_rules: [
                  {
                    escalation_delay_in_minutes: Number(trimmed(fields, "delayMinutes") || 30),
                    targets,
                  },
                ],
              },
            },
          });
          if (!res?.escalation_policy) throw new Error("PagerDuty did not return the new policy.");
          return mapEscalationPolicy(accountId, res.escalation_policy);
        }
        case "pagerduty-team": {
          const description = trimmed(fields, "description");
          const res = await this.api.post("/teams", {
            body: {
              team: {
                type: "team",
                name: trimmed(fields, "name"),
                ...(description ? { description } : {}),
              },
            },
          });
          if (!res?.team) throw new Error("PagerDuty did not return the new team.");
          return mapTeam(accountId, res.team);
        }
        case "pagerduty-maintenance-window": {
          const services = parseIdList(trimmed(fields, "services"));
          if (services.length === 0) throw new Error("Pick at least one service.");
          const description = trimmed(fields, "description");
          const res = await withFrom(this.paging, null, (from) =>
            this.api.post("/maintenance_windows", {
              body: {
                maintenance_window: {
                  type: "maintenance_window",
                  start_time: trimmed(fields, "startTime"),
                  end_time: trimmed(fields, "endTime"),
                  ...(description ? { description } : {}),
                  services: services.map((s) => ref(s, "service_reference")),
                },
              },
              headers: { From: from },
            }),
          );
          if (!res?.maintenance_window) throw new Error("PagerDuty did not return the window.");
          return mapMaintenanceWindow(accountId, res.maintenance_window);
        }
        case "pagerduty-business-service": {
          const team = trimmed(fields, "teamId");
          const description = trimmed(fields, "description");
          const contact = trimmed(fields, "pointOfContact");
          const res = await this.api.post("/business_services", {
            body: {
              business_service: {
                name: trimmed(fields, "name"),
                ...(description ? { description } : {}),
                ...(contact ? { point_of_contact: contact } : {}),
                ...(team ? { team: ref(team, "team_reference") } : {}),
              },
            },
          });
          if (!res?.business_service) throw new Error("PagerDuty did not return the service.");
          return mapBusinessService(accountId, res.business_service);
        }
        default:
          throw new Error(`PagerDuty plugin: creating "${typeId}" is not supported`);
      }
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      this.invalidate();
      switch (typeId) {
        case "pagerduty-service": {
          const resolve = seconds(fields, "autoResolveMinutes");
          const ack = seconds(fields, "acknowledgementTimeoutMinutes");
          await this.api.put(`/services/${id}`, {
            body: {
              service: {
                type: "service",
                ...("name" in fields ? { name: trimmed(fields, "name") } : {}),
                ...("description" in fields ? { description: trimmed(fields, "description") } : {}),
                ...(resolve !== undefined ? { auto_resolve_timeout: resolve } : {}),
                ...(ack !== undefined ? { acknowledgement_timeout: ack } : {}),
              },
            },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "pagerduty-escalation-policy": {
          // PUT takes the whole policy and the document does not say what it does with a field
          // left out, so everything settable goes back as read, with only the edit changed.
          const current = await this.api.get(`/escalation_policies/${id}`, {
            query: { "include[]": ["escalation_rule_assignment_strategies"] },
          });
          const p = current?.escalation_policy;
          if (!p) throw new PagerDutyApiError(404, "PagerDuty escalation policy not found");
          const description =
            "description" in fields ? trimmed(fields, "description") : p.description;
          const numLoops =
            "numLoops" in fields ? Number(trimmed(fields, "numLoops") || 0) : p.num_loops;
          await this.api.put(`/escalation_policies/${id}`, {
            body: {
              escalation_policy: {
                type: "escalation_policy",
                name: "name" in fields ? trimmed(fields, "name") : p.name,
                ...(description !== undefined ? { description } : {}),
                ...(numLoops !== undefined ? { num_loops: numLoops } : {}),
                ...(p.on_call_handoff_notifications
                  ? { on_call_handoff_notifications: p.on_call_handoff_notifications }
                  : {}),
                ...(p.teams?.length
                  ? {
                      teams: p.teams.map((t) =>
                        ref(requireId(t.id, "a team on an escalation policy"), "team_reference"),
                      ),
                    }
                  : {}),
                escalation_rules: (p.escalation_rules ?? []).map(ruleToKeep),
              },
            },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "pagerduty-team": {
          await this.api.put(`/teams/${id}`, {
            body: {
              team: {
                type: "team",
                ...("name" in fields ? { name: trimmed(fields, "name") } : {}),
                ...("description" in fields ? { description: trimmed(fields, "description") } : {}),
              },
            },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "pagerduty-maintenance-window": {
          await this.api.put(`/maintenance_windows/${id}`, {
            body: {
              maintenance_window: {
                type: "maintenance_window",
                ...("description" in fields ? { description: trimmed(fields, "description") } : {}),
                ...("startTime" in fields ? { start_time: trimmed(fields, "startTime") } : {}),
                ...("endTime" in fields ? { end_time: trimmed(fields, "endTime") } : {}),
              },
            },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "pagerduty-business-service": {
          await this.api.put(`/business_services/${id}`, {
            body: {
              business_service: {
                ...("name" in fields ? { name: trimmed(fields, "name") } : {}),
                ...("description" in fields ? { description: trimmed(fields, "description") } : {}),
                ...("pointOfContact" in fields
                  ? { point_of_contact: trimmed(fields, "pointOfContact") }
                  : {}),
              },
            },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "pagerduty-event-orchestration": {
          await this.api.put(`/event_orchestrations/${id}`, {
            body: {
              orchestration: {
                ...("name" in fields ? { name: trimmed(fields, "name") } : {}),
                ...("description" in fields ? { description: trimmed(fields, "description") } : {}),
              },
            },
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        default:
          throw new Error(`PagerDuty plugin: editing "${typeId}" is not supported`);
      }
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const remove = this.deletion(typeId, pathEncode(externalIdOf(resourceId)));
      if (!remove) throw new Error(`PagerDuty plugin: deleting "${typeId}" is not supported`);
      this.invalidate();
      await remove();
    });
  }

  private deletion(typeId: string, id: NoSlashString): (() => Promise<void>) | undefined {
    switch (typeId) {
      case "pagerduty-service":
        return () => this.api.delete(`/services/${id}`);
      case "pagerduty-escalation-policy":
        return () => this.api.delete(`/escalation_policies/${id}`);
      case "pagerduty-schedule":
        return () => this.api.delete(`/schedules/${id}`);
      case "pagerduty-team":
        return () => this.api.delete(`/teams/${id}`);
      case "pagerduty-maintenance-window":
        return () => this.api.delete(`/maintenance_windows/${id}`);
      case "pagerduty-business-service":
        return () => this.api.delete(`/business_services/${id}`);
      case "pagerduty-event-orchestration":
        return () => this.api.delete(`/event_orchestrations/${id}`);
      default:
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async putIncident(incidentId: string, incident: IncidentChange): Promise<void> {
    await withFrom(this.paging, null, (from) =>
      this.api.put(`/incidents/${pathEncode(incidentId)}`, {
        body: { incident: { type: "incident_reference", ...incident } },
        headers: { From: from },
      }),
    );
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      const id = pathEncode(ext);
      if (typeId === "pagerduty-incident") {
        if (actionId === ACTIONS.acknowledge)
          return this.putIncident(ext, { status: "acknowledged" });
        if (actionId === ACTIONS.resolve) return this.putIncident(ext, { status: "resolved" });
      }
      if (
        typeId === "pagerduty-service" &&
        (actionId === ACTIONS.disable || actionId === ACTIONS.enable)
      ) {
        await this.api.put(`/services/${id}`, {
          body: {
            service: {
              type: "service",
              status: actionId === ACTIONS.disable ? "disabled" : "active",
            },
          },
        });
        return;
      }
      if (typeId === "pagerduty-schedule" && actionId.startsWith(ACTIONS.deleteOverridePrefix)) {
        const overrideId = actionId.slice(ACTIONS.deleteOverridePrefix.length);
        await this.api.delete(`/schedules/${id}/overrides/${pathEncode(overrideId)}`);
        return;
      }
      if (typeId === "pagerduty-maintenance-window" && actionId === COMMANDS.endMaintenance) {
        await this.api.put(`/maintenance_windows/${id}`, {
          body: {
            maintenance_window: { type: "maintenance_window", end_time: new Date().toISOString() },
          },
        });
        return;
      }
      throw new Error(`PagerDuty plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const values = parsePromptValues(args);
      const ext = externalIdOf(resourceId);
      const id = pathEncode(ext);
      if (typeId === "pagerduty-service" && command === COMMANDS.createIncident) {
        const title = (values["title"] ?? "").trim();
        if (!title) throw new Error("Give the incident a title.");
        const priority = (values["priorityId"] ?? "").trim();
        const details = (values["details"] ?? "").trim();
        return withFrom(this.paging, null, (from) =>
          this.api.post("/incidents", {
            body: {
              incident: {
                type: "incident",
                title,
                service: ref(ext, "service_reference"),
                urgency: values["urgency"] || "high",
                ...(priority ? { priority: ref(priority, "priority_reference") } : {}),
                ...(details ? { body: { type: "incident_body", details } } : {}),
              },
            },
            headers: { From: from },
          }),
        );
      }
      if (typeId === "pagerduty-service" && command === COMMANDS.changeEscalationPolicy) {
        const policy = (values["escalationPolicyId"] ?? "").trim();
        if (!policy) throw new Error("Pick an escalation policy.");
        return this.api.put(`/services/${id}`, {
          body: {
            service: {
              type: "service",
              escalation_policy: ref(policy, "escalation_policy_reference"),
            },
          },
        });
      }
      if (typeId === "pagerduty-schedule" && command === COMMANDS.addOverride) {
        const user = (values["userId"] ?? "").trim();
        const start = (values["start"] ?? "").trim();
        const end = (values["end"] ?? "").trim();
        if (!user || !start || !end) throw new Error("Pick who, from and to.");
        if (Date.parse(end) <= Date.parse(start))
          throw new Error("The override must end after it starts.");
        const res = await this.api.post(`/schedules/${id}/overrides`, {
          body: { overrides: [{ start, end, user: ref(user, "user_reference") }] },
        });
        const failed = (Array.isArray(res) ? res : []).find((r) => r.status && r.status >= 400);
        if (failed)
          throw new Error(`PagerDuty refused the override: ${(failed.errors ?? []).join("; ")}`);
        return { ok: true };
      }
      if (typeId === "pagerduty-incident") {
        switch (command) {
          case COMMANDS.reassign: {
            const [kind, target] = (values["assignee"] ?? "").split(":");
            if (!target) throw new Error("Pick who to assign it to.");
            await this.putIncident(
              ext,
              kind === "policy"
                ? { escalation_policy: ref(target, "escalation_policy_reference") }
                : { assignments: [{ assignee: ref(target, "user_reference") }] },
            );
            return { ok: true };
          }
          case COMMANDS.addNote: {
            const content = (values["content"] ?? "").trim();
            if (!content) throw new Error("Write the note.");
            return withFrom(this.paging, null, (from) =>
              this.api.post(`/incidents/${id}/notes`, {
                body: { note: { content } },
                headers: { From: from },
              }),
            );
          }
          case COMMANDS.snooze: {
            const minutes = Number(values["minutes"] ?? 60);
            return withFrom(this.paging, null, (from) =>
              this.api.post(`/incidents/${id}/snooze`, {
                body: { duration: Math.round(minutes * 60) },
                headers: { From: from },
              }),
            );
          }
          case COMMANDS.setUrgency: {
            const urgency = values["urgency"];
            if (urgency !== "high" && urgency !== "low") throw new Error("Pick high or low.");
            await this.putIncident(ext, { urgency });
            return { ok: true };
          }
          case COMMANDS.setPriority: {
            const priority = (values["priorityId"] ?? "").trim();
            if (!priority) throw new Error("Pick a priority.");
            await this.putIncident(ext, { priority: ref(priority, "priority_reference") });
            return { ok: true };
          }
        }
      }
      throw new Error(`PagerDuty plugin: unknown command "${command}" for "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Paging capability
  // -------------------------------------------------------------------------

  listPagingTargets(): PluginEffect<PagingTarget[]> {
    return attempt(async () => {
      return listTargets(this.paging);
    });
  }

  sendPagingEvent(targetId: string, event: PagingEvent): PluginEffect<PagingEventResult> {
    return attempt(async () => {
      return sendPagingEvent(this.paging, targetId, event);
    });
  }

  listPagingOnCallSources(): PluginEffect<PagingOnCallSource[]> {
    return attempt(async () => {
      return listOnCallSources(this.paging);
    });
  }

  resolvePagingOnCall(sourceId: string, at: Date): PluginEffect<PagingOnCallPerson[]> {
    return attempt(async () => {
      return resolveOnCall(this.paging, sourceId, at);
    });
  }

  listPagingIncidents(query: PagingIncidentQuery): PluginEffect<PagingIncident[]> {
    return attempt(async () => {
      return listIncidents(this.paging, query);
    });
  }

  getPagingIncident(incidentId: string): PluginEffect<PagingIncident | null> {
    return attempt(async () => {
      return getIncident(this.paging, incidentId);
    });
  }

  updatePagingIncident(
    incidentId: string,
    update: PagingIncidentUpdate,
  ): PluginEffect<PagingIncident> {
    return attempt(async () => {
      return updateIncident(this.paging, incidentId, update);
    });
  }

  registerPagingWebhook(url: string): PluginEffect<PagingWebhookRegistration> {
    return attempt(async () => {
      return registerWebhook(this.paging, url);
    });
  }

  removePagingWebhook(webhookId: string): PluginEffect<void> {
    return attempt(async () => {
      return removeWebhook(this.paging, webhookId);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderPagerDutyDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderPagerDutySidebar(resource);
  }
}
