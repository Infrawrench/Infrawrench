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
import { externalIdOf } from "@infrawrench/plugin-base";
import type { PagerDutyRegion, PagerDutyTransport, QueryValue } from "./api.js";
import { PagerDutyApiError, pdFetch, pdList, statusOf } from "./api.js";
import type {
  PdBusinessService,
  PdEscalationPolicy,
  PdIncident,
  PdIntegration,
  PdMaintenanceWindow,
  PdOrchestration,
  PdOverride,
  PdPriority,
  PdSchedule,
  PdService,
  PdTeam,
  PdUser,
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
/** Resolved incidents older than this are not listed as resources. */
const RESOLVED_WINDOW_MS = 7 * 24 * 3600_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
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
    const parsed = JSON.parse(first) as Record<string, unknown>;
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
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // fall through
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ref = (id: string, type: string) => ({ id, type });

export class PagerDutyClient implements PluginClient {
  private readonly transport: PagerDutyTransport;
  private readonly fromEmail: string;
  private readonly paging: PagingContext;
  private userCache: Cached<PdUser[]> | undefined;
  private policyCache: Cached<PdEscalationPolicy[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) {
      throw new Error(
        "PagerDuty plugin: enter a REST API key (Integrations, API Access Keys in PagerDuty)",
      );
    }
    const region: PagerDutyRegion = (credentials["region"] ?? "").trim() === "eu" ? "eu" : "us";
    const caCert = credentials["caCert"] ?? "";
    this.fromEmail = (credentials["fromEmail"] ?? "").trim();
    this.transport = {
      apiKey,
      region,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.paging = { transport: this.transport, fromEmail: this.fromEmail, routingKeys: new Map() };
  }

  private get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return pdFetch<T>(this.transport, path, query ? { query } : {});
  }

  private list<T>(path: string, key: string, query: Record<string, QueryValue> = {}): Promise<T[]> {
    return pdList<T>(this.transport, path, key, query);
  }

  private invalidate(): void {
    this.userCache = undefined;
    this.policyCache = undefined;
  }

  private users(): Promise<PdUser[]> {
    if (this.userCache && Date.now() - this.userCache.at < CACHE_MS) return this.userCache.value;
    const value = this.list<PdUser>("/users", "users", { "include[]": ["teams"] });
    this.userCache = { at: Date.now(), value };
    return value;
  }

  private policies(): Promise<PdEscalationPolicy[]> {
    if (this.policyCache && Date.now() - this.policyCache.at < CACHE_MS) {
      return this.policyCache.value;
    }
    const value = this.list<PdEscalationPolicy>("/escalation_policies", "escalation_policies", {
      "include[]": ["services", "teams"],
      sort_by: "name",
    });
    this.policyCache = { at: Date.now(), value };
    return value;
  }

  private async userOptions(): Promise<Option[]> {
    return (await this.users()).map((u) => ({
      id: u.id ?? "",
      name: u.name ?? u.email ?? u.id ?? "",
      ...(u.email ? { description: u.email } : {}),
    }));
  }

  private async policyOptions(): Promise<Option[]> {
    return (await this.policies()).map((p) => ({ id: p.id ?? "", name: p.name ?? p.id ?? "" }));
  }

  private async priorityOptions(): Promise<Option[]> {
    try {
      const priorities = await this.list<PdPriority>("/priorities", "priorities");
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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "pagerduty-service":
        return (
          await this.list<PdService>("/services", "services", {
            "include[]": ["integrations", "teams"],
            sort_by: "name",
          })
        ).map((s) => mapService(accountId, s));
      case "pagerduty-escalation-policy":
        return (await this.policies()).map((p) => mapEscalationPolicy(accountId, p));
      case "pagerduty-schedule":
        return (await this.list<PdSchedule>("/schedules", "schedules")).map((s) =>
          mapSchedule(accountId, s),
        );
      case "pagerduty-team":
        return (await this.list<PdTeam>("/teams", "teams")).map((t) => mapTeam(accountId, t));
      case "pagerduty-user":
        return (await this.users()).map((u) => mapUser(accountId, u));
      case "pagerduty-incident": {
        const [open, resolved] = await Promise.all([
          this.list<PdIncident>("/incidents", "incidents", {
            "statuses[]": ["triggered", "acknowledged"],
            date_range: "all",
            "include[]": ["assignees"],
          }),
          this.list<PdIncident>("/incidents", "incidents", {
            "statuses[]": ["resolved"],
            since: new Date(Date.now() - RESOLVED_WINDOW_MS).toISOString(),
            until: new Date().toISOString(),
            "include[]": ["assignees"],
          }),
        ]);
        return [...open, ...resolved].map((i) => mapIncident(accountId, i));
      }
      case "pagerduty-maintenance-window":
        return (
          await this.list<PdMaintenanceWindow>("/maintenance_windows", "maintenance_windows", {
            filter: "open",
          })
        ).map((w) => mapMaintenanceWindow(accountId, w));
      case "pagerduty-business-service":
        return (await this.list<PdBusinessService>("/business_services", "business_services")).map(
          (b) => mapBusinessService(accountId, b),
        );
      case "pagerduty-event-orchestration":
        try {
          return (await this.list<PdOrchestration>("/event_orchestrations", "orchestrations")).map(
            (o) => mapOrchestration(accountId, o),
          );
        } catch (err) {
          // Event orchestration is not on every plan; a 403 means none to list.
          if (statusOf(err) === 403) return [];
          throw err;
        }
      default:
        throw new Error(`PagerDuty plugin: unknown resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Single reads (with what the detail page shows)
  // -------------------------------------------------------------------------

  private async onCallRows(query: Record<string, QueryValue>): Promise<OnCallRow[]> {
    const oncalls = await this.list<{
      user?: PdUser;
      escalation_level?: number;
      schedule?: { summary?: string } | null;
      end?: string | null;
    }>("/oncalls", "oncalls", { ...query, "include[]": ["users"], earliest: true });
    return oncalls
      .map((o) => ({
        level: o.escalation_level ?? 1,
        name: o.user?.name ?? o.user?.summary ?? "",
        email: o.user?.email ?? "",
        schedule: o.schedule?.summary ?? "",
        until: o.end ?? "",
      }))
      .sort((a, b) => a.level - b.level);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const id = encodeURIComponent(ext);
    switch (typeId) {
      case "pagerduty-service": {
        const res = await this.get<{ service?: PdService }>(`/services/${id}`, {
          "include[]": ["integrations", "teams"],
        });
        if (!res?.service) throw new PagerDutyApiError(404, "PagerDuty service not found");
        const r = mapService(accountId, res.service);
        const s = res.service;
        const [oncall, summary, open, policies, priorities] = await Promise.all([
          s.escalation_policy?.id
            ? this.onCallRows({ "escalation_policy_ids[]": [s.escalation_policy.id] }).catch(
                () => [],
              )
            : Promise.resolve([]),
          serviceAnalytics(this.transport, ext, rangeOrDefault(undefined))
            .then((rows) => rows[0])
            .catch(() => undefined),
          this.list<PdIncident>("/incidents", "incidents", {
            "service_ids[]": [ext],
            "statuses[]": ["triggered", "acknowledged"],
            date_range: "all",
          }).catch(() => [] as PdIncident[]),
          this.policyOptions().catch(() => [] as Option[]),
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
        const res = await this.get<{ escalation_policy?: PdEscalationPolicy }>(
          `/escalation_policies/${id}`,
          { "include[]": ["services", "teams", "targets"] },
        );
        if (!res?.escalation_policy) {
          throw new PagerDutyApiError(404, "PagerDuty escalation policy not found");
        }
        const r = mapEscalationPolicy(accountId, res.escalation_policy);
        const oncall = await this.onCallRows({ "escalation_policy_ids[]": [ext] }).catch(() => []);
        r.fields[ONCALL_KEY] = JSON.stringify(oncall);
        return r;
      }
      case "pagerduty-schedule": {
        const now = Date.now();
        const since = new Date(now).toISOString();
        const res = await this.get<{ schedule?: PdSchedule }>(`/schedules/${id}`, {
          since,
          until: new Date(now + 7 * 24 * 3600_000).toISOString(),
        });
        if (!res?.schedule) throw new PagerDutyApiError(404, "PagerDuty schedule not found");
        const r = mapSchedule(accountId, res.schedule);
        const shifts: ShiftRow[] = (
          res.schedule.final_schedule?.rendered_schedule_entries ?? []
        ).map((e) => ({ name: e.user?.summary ?? "", start: e.start ?? "", end: e.end ?? "" }));
        const [overrides, users] = await Promise.all([
          this.get<{ overrides?: PdOverride[] }>(`/schedules/${id}/overrides`, {
            since,
            until: new Date(now + 30 * 24 * 3600_000).toISOString(),
            editable: true,
          }).catch(() => ({ overrides: [] as PdOverride[] })),
          this.userOptions().catch(() => [] as Option[]),
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
        const res = await this.get<{ team?: PdTeam }>(`/teams/${id}`);
        if (!res?.team) throw new PagerDutyApiError(404, "PagerDuty team not found");
        return mapTeam(accountId, res.team);
      }
      case "pagerduty-user": {
        const res = await this.get<{ user?: PdUser }>(`/users/${id}`, { "include[]": ["teams"] });
        if (!res?.user) throw new PagerDutyApiError(404, "PagerDuty user not found");
        return mapUser(accountId, res.user);
      }
      case "pagerduty-incident": {
        const res = await this.get<{ incident?: PdIncident }>(`/incidents/${id}`, {
          "include[]": ["assignees", "services", "priorities"],
        });
        if (!res?.incident) throw new PagerDutyApiError(404, "PagerDuty incident not found");
        const r = mapIncident(accountId, res.incident);
        const [notes, alerts, users, policies, priorities] = await Promise.all([
          this.get<{
            notes?: Array<{ created_at?: string; user?: { summary?: string }; content?: string }>;
          }>(`/incidents/${id}/notes`).catch(() => ({ notes: [] })),
          this.get<{
            alerts?: Array<{
              alert_key?: string;
              status?: string;
              summary?: string;
              created_at?: string;
            }>;
          }>(`/incidents/${id}/alerts`).catch(() => ({ alerts: [] })),
          this.userOptions().catch(() => [] as Option[]),
          this.policyOptions().catch(() => [] as Option[]),
          this.priorityOptions(),
        ]);
        const noteRows: NoteRow[] = (notes?.notes ?? []).map((n) => ({
          at: n.created_at ?? "",
          who: n.user?.summary ?? "",
          content: n.content ?? "",
        }));
        const alertRows: AlertRow[] = (alerts?.alerts ?? []).map((a) => ({
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
        const res = await this.get<{ maintenance_window?: PdMaintenanceWindow }>(
          `/maintenance_windows/${id}`,
          { "include[]": ["services"] },
        );
        if (!res?.maintenance_window) {
          throw new PagerDutyApiError(404, "PagerDuty maintenance window not found");
        }
        return mapMaintenanceWindow(accountId, res.maintenance_window);
      }
      case "pagerduty-business-service": {
        const res = await this.get<{ business_service?: PdBusinessService }>(
          `/business_services/${id}`,
        );
        if (!res?.business_service) {
          throw new PagerDutyApiError(404, "PagerDuty business service not found");
        }
        return mapBusinessService(accountId, res.business_service);
      }
      case "pagerduty-event-orchestration": {
        const res = await this.get<{ orchestration?: PdOrchestration }>(
          `/event_orchestrations/${id}`,
        );
        if (!res?.orchestration) {
          throw new PagerDutyApiError(404, "PagerDuty event orchestration not found");
        }
        return mapOrchestration(accountId, res.orchestration);
      }
      default:
        throw new Error(`PagerDuty plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
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
        return serviceRoutingKey(this.transport, ext, { create: false });
      case "pagerduty-event-orchestration/routingKey":
        return orchestrationRoutingKey(this.transport, ext);
      default:
        throw new Error(
          `PagerDuty plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
        );
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "pagerduty-service") return [];
    const rows = await serviceAnalytics(
      this.transport,
      externalIdOf(resourceId),
      rangeOrDefault(timeRange),
      "day",
    );
    return seriesFromRows(rows);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
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
          this.list<PdSchedule>("/schedules", "schedules"),
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
        const services = await this.list<PdService>("/services", "services", { sort_by: "name" });
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
        const teams = await this.list<PdTeam>("/teams", "teams").catch(() => [] as PdTeam[]);
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
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    this.invalidate();
    switch (typeId) {
      case "pagerduty-service": {
        const policy = trimmed(fields, "escalationPolicyId");
        if (!trimmed(fields, "name") || !policy) {
          throw new Error("A service needs a name and an escalation policy.");
        }
        const urgency = trimmed(fields, "urgency") || "high";
        const res = await pdFetch<{ service?: PdService }>(this.transport, "/services", {
          body: {
            service: {
              type: "service",
              name: trimmed(fields, "name"),
              description: trimmed(fields, "description") || undefined,
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
        const res = await pdFetch<{ escalation_policy?: PdEscalationPolicy }>(
          this.transport,
          "/escalation_policies",
          {
            body: {
              escalation_policy: {
                type: "escalation_policy",
                name: trimmed(fields, "name"),
                description: trimmed(fields, "description") || undefined,
                num_loops: Number(trimmed(fields, "numLoops") || 0),
                escalation_rules: [
                  {
                    escalation_delay_in_minutes: Number(trimmed(fields, "delayMinutes") || 30),
                    targets,
                  },
                ],
              },
            },
          },
        );
        if (!res?.escalation_policy) throw new Error("PagerDuty did not return the new policy.");
        return mapEscalationPolicy(accountId, res.escalation_policy);
      }
      case "pagerduty-team": {
        const res = await pdFetch<{ team?: PdTeam }>(this.transport, "/teams", {
          body: {
            team: {
              type: "team",
              name: trimmed(fields, "name"),
              description: trimmed(fields, "description") || undefined,
            },
          },
        });
        if (!res?.team) throw new Error("PagerDuty did not return the new team.");
        return mapTeam(accountId, res.team);
      }
      case "pagerduty-maintenance-window": {
        const services = parseIdList(trimmed(fields, "services"));
        if (services.length === 0) throw new Error("Pick at least one service.");
        const res = await withFrom(this.paging, null, (from) =>
          pdFetch<{ maintenance_window?: PdMaintenanceWindow }>(
            this.transport,
            "/maintenance_windows",
            {
              body: {
                maintenance_window: {
                  type: "maintenance_window",
                  start_time: trimmed(fields, "startTime"),
                  end_time: trimmed(fields, "endTime"),
                  description: trimmed(fields, "description") || undefined,
                  services: services.map((s) => ref(s, "service_reference")),
                },
              },
              from,
            },
          ),
        );
        if (!res?.maintenance_window) throw new Error("PagerDuty did not return the window.");
        return mapMaintenanceWindow(accountId, res.maintenance_window);
      }
      case "pagerduty-business-service": {
        const team = trimmed(fields, "teamId");
        const res = await pdFetch<{ business_service?: PdBusinessService }>(
          this.transport,
          "/business_services",
          {
            body: {
              business_service: {
                name: trimmed(fields, "name"),
                description: trimmed(fields, "description") || undefined,
                point_of_contact: trimmed(fields, "pointOfContact") || undefined,
                ...(team ? { team: ref(team, "team_reference") } : {}),
              },
            },
          },
        );
        if (!res?.business_service) throw new Error("PagerDuty did not return the service.");
        return mapBusinessService(accountId, res.business_service);
      }
      default:
        throw new Error(`PagerDuty plugin: creating "${typeId}" is not supported`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const id = encodeURIComponent(ext);
    this.invalidate();
    switch (typeId) {
      case "pagerduty-service": {
        const body: Record<string, unknown> = { type: "service" };
        if ("name" in fields) body["name"] = trimmed(fields, "name");
        if ("description" in fields) body["description"] = trimmed(fields, "description");
        const resolve = seconds(fields, "autoResolveMinutes");
        if (resolve !== undefined) body["auto_resolve_timeout"] = resolve;
        const ack = seconds(fields, "acknowledgementTimeoutMinutes");
        if (ack !== undefined) body["acknowledgement_timeout"] = ack;
        await pdFetch(this.transport, `/services/${id}`, {
          method: "PUT",
          body: { service: body },
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "pagerduty-escalation-policy": {
        // PUT needs the rules back, so merge onto the current policy.
        const current = await this.get<{ escalation_policy?: PdEscalationPolicy }>(
          `/escalation_policies/${id}`,
        );
        const p = current?.escalation_policy;
        if (!p) throw new PagerDutyApiError(404, "PagerDuty escalation policy not found");
        await pdFetch(this.transport, `/escalation_policies/${id}`, {
          method: "PUT",
          body: {
            escalation_policy: {
              type: "escalation_policy",
              name: "name" in fields ? trimmed(fields, "name") : p.name,
              description: "description" in fields ? trimmed(fields, "description") : p.description,
              num_loops:
                "numLoops" in fields ? Number(trimmed(fields, "numLoops") || 0) : p.num_loops,
              escalation_rules: (p.escalation_rules ?? []).map((r) => ({
                ...(r.id ? { id: r.id } : {}),
                escalation_delay_in_minutes: r.escalation_delay_in_minutes,
                targets: (r.targets ?? []).map((t) => ref(t.id ?? "", t.type ?? "user_reference")),
              })),
            },
          },
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "pagerduty-team": {
        const body: Record<string, unknown> = { type: "team" };
        if ("name" in fields) body["name"] = trimmed(fields, "name");
        if ("description" in fields) body["description"] = trimmed(fields, "description");
        await pdFetch(this.transport, `/teams/${id}`, { method: "PUT", body: { team: body } });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "pagerduty-maintenance-window": {
        const body: Record<string, unknown> = { type: "maintenance_window" };
        if ("description" in fields) body["description"] = trimmed(fields, "description");
        if ("startTime" in fields) body["start_time"] = trimmed(fields, "startTime");
        if ("endTime" in fields) body["end_time"] = trimmed(fields, "endTime");
        await pdFetch(this.transport, `/maintenance_windows/${id}`, {
          method: "PUT",
          body: { maintenance_window: body },
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "pagerduty-business-service": {
        const body: Record<string, unknown> = {};
        if ("name" in fields) body["name"] = trimmed(fields, "name");
        if ("description" in fields) body["description"] = trimmed(fields, "description");
        if ("pointOfContact" in fields)
          body["point_of_contact"] = trimmed(fields, "pointOfContact");
        await pdFetch(this.transport, `/business_services/${id}`, {
          method: "PUT",
          body: { business_service: body },
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "pagerduty-event-orchestration": {
        const body: Record<string, unknown> = {};
        if ("name" in fields) body["name"] = trimmed(fields, "name");
        if ("description" in fields) body["description"] = trimmed(fields, "description");
        await pdFetch(this.transport, `/event_orchestrations/${id}`, {
          method: "PUT",
          body: { orchestration: body },
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`PagerDuty plugin: editing "${typeId}" is not supported`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    const paths: Record<string, string> = {
      "pagerduty-service": `/services/${id}`,
      "pagerduty-escalation-policy": `/escalation_policies/${id}`,
      "pagerduty-schedule": `/schedules/${id}`,
      "pagerduty-team": `/teams/${id}`,
      "pagerduty-maintenance-window": `/maintenance_windows/${id}`,
      "pagerduty-business-service": `/business_services/${id}`,
      "pagerduty-event-orchestration": `/event_orchestrations/${id}`,
    };
    const path = paths[typeId];
    if (!path) throw new Error(`PagerDuty plugin: deleting "${typeId}" is not supported`);
    this.invalidate();
    await pdFetch(this.transport, path, { method: "DELETE" });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async putIncident(incidentId: string, incident: Record<string, unknown>): Promise<void> {
    await withFrom(this.paging, null, (from) =>
      pdFetch(this.transport, `/incidents/${encodeURIComponent(incidentId)}`, {
        method: "PUT",
        body: { incident: { type: "incident_reference", ...incident } },
        from,
      }),
    );
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const ext = externalIdOf(resourceId);
    const id = encodeURIComponent(ext);
    if (typeId === "pagerduty-incident") {
      if (actionId === ACTIONS.acknowledge)
        return this.putIncident(ext, { status: "acknowledged" });
      if (actionId === ACTIONS.resolve) return this.putIncident(ext, { status: "resolved" });
    }
    if (
      typeId === "pagerduty-service" &&
      (actionId === ACTIONS.disable || actionId === ACTIONS.enable)
    ) {
      await pdFetch(this.transport, `/services/${id}`, {
        method: "PUT",
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
      await pdFetch(
        this.transport,
        `/schedules/${id}/overrides/${encodeURIComponent(overrideId)}`,
        {
          method: "DELETE",
        },
      );
      return;
    }
    if (typeId === "pagerduty-maintenance-window" && actionId === COMMANDS.endMaintenance) {
      await pdFetch(this.transport, `/maintenance_windows/${id}`, {
        method: "PUT",
        body: {
          maintenance_window: { type: "maintenance_window", end_time: new Date().toISOString() },
        },
      });
      return;
    }
    throw new Error(`PagerDuty plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = parsePromptValues(args);
    const ext = externalIdOf(resourceId);
    const id = encodeURIComponent(ext);
    if (typeId === "pagerduty-service" && command === COMMANDS.createIncident) {
      const title = (values["title"] ?? "").trim();
      if (!title) throw new Error("Give the incident a title.");
      const priority = (values["priorityId"] ?? "").trim();
      const details = (values["details"] ?? "").trim();
      return withFrom(this.paging, null, (from) =>
        pdFetch(this.transport, "/incidents", {
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
          from,
        }),
      );
    }
    if (typeId === "pagerduty-service" && command === COMMANDS.changeEscalationPolicy) {
      const policy = (values["escalationPolicyId"] ?? "").trim();
      if (!policy) throw new Error("Pick an escalation policy.");
      return pdFetch(this.transport, `/services/${id}`, {
        method: "PUT",
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
      const res = await pdFetch<Array<{ status?: number; errors?: string[] }>>(
        this.transport,
        `/schedules/${id}/overrides`,
        { body: { overrides: [{ start, end, user: ref(user, "user_reference") }] } },
      );
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
            pdFetch(this.transport, `/incidents/${id}/notes`, {
              body: { note: { content } },
              from,
            }),
          );
        }
        case COMMANDS.snooze: {
          const minutes = Number(values["minutes"] ?? 60);
          return withFrom(this.paging, null, (from) =>
            pdFetch(this.transport, `/incidents/${id}/snooze`, {
              body: { duration: Math.round(minutes * 60) },
              from,
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
  }

  // -------------------------------------------------------------------------
  // Paging capability
  // -------------------------------------------------------------------------

  listPagingTargets(): Promise<PagingTarget[]> {
    return listTargets(this.paging);
  }

  sendPagingEvent(targetId: string, event: PagingEvent): Promise<PagingEventResult> {
    return sendPagingEvent(this.paging, targetId, event);
  }

  listPagingOnCallSources(): Promise<PagingOnCallSource[]> {
    return listOnCallSources(this.paging);
  }

  resolvePagingOnCall(sourceId: string, at: Date): Promise<PagingOnCallPerson[]> {
    return resolveOnCall(this.paging, sourceId, at);
  }

  listPagingIncidents(query: PagingIncidentQuery): Promise<PagingIncident[]> {
    return listIncidents(this.paging, query);
  }

  getPagingIncident(incidentId: string): Promise<PagingIncident | null> {
    return getIncident(this.paging, incidentId);
  }

  updatePagingIncident(incidentId: string, update: PagingIncidentUpdate): Promise<PagingIncident> {
    return updateIncident(this.paging, incidentId, update);
  }

  registerPagingWebhook(url: string): Promise<PagingWebhookRegistration> {
    return registerWebhook(this.paging, url);
  }

  removePagingWebhook(webhookId: string): Promise<void> {
    return removeWebhook(this.paging, webhookId);
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
