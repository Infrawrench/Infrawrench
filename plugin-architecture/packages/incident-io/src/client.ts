import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  PagingEvent,
  PagingEventResult,
  PagingIncident,
  PagingIncidentQuery,
  PagingIncidentUpdate,
  PagingOnCallPerson,
  PagingOnCallSource,
  PagingTarget,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  externalIdOf,
  pathEncode,
  requireListPage,
  rethrowIncompleteList,
} from "@infrawrench/plugin-base";
import type { IoApi } from "./api.js";
import { IncidentIoApiError, createIoApi, listPlace, readAll } from "./api.js";
import type {
  IoEscalation,
  IoIncident,
  IoIncidentStatus,
  IoPerson,
  IoSeverity,
  IoShift,
  IoUser,
} from "./mappers.js";
import {
  ENDED_ESCALATION_STATUSES,
  OPEN_CATEGORIES,
  mapAlertRoute,
  mapAlertSource,
  mapCatalogType,
  mapEscalation,
  mapEscalationPath,
  mapIncident,
  mapIncidentStatus,
  mapMaintenanceWindow,
  mapSchedule,
  mapSeverity,
  mapStatusPage,
  mapTeam,
  mapUser,
  mapWorkflow,
} from "./mappers.js";
import type { PagingContext } from "./paging.js";
import {
  alertSources,
  getIncident,
  incidentStatuses,
  listIncidents,
  listOnCallSources,
  listTargets,
  resolveOnCall,
  scheduleEntries,
  sendPagingEvent,
  updateIncident,
} from "./paging.js";
import type { AlertRow, DurationRow, EventRow, Option, OverrideRow, ShiftRow } from "./render.js";
import {
  ACTIONS,
  ALERTS_KEY,
  COMMANDS,
  DURATIONS_KEY,
  EVENTS_KEY,
  LAYERS_KEY,
  OVERRIDES_KEY,
  RESPONDERS_KEY,
  SEVERITIES_KEY,
  SHIFTS_KEY,
  STATUSES_KEY,
  USERS_KEY,
  renderIncidentIoDetail,
  renderIncidentIoSidebar,
} from "./render.js";

/** Closed incidents changed longer ago than this are not listed as resources. */
const RECENT_WINDOW_MS = 7 * 24 * 3600_000;
/** Ended escalations changed longer ago than this are not listed as resources. */
const ESCALATION_WINDOW_MS = 90 * 24 * 3600_000;

const daysAgo = (ms: number): string => new Date(Date.now() - ms).toISOString().slice(0, 10);

const trimmed = (fields: Record<string, string>, key: string): string => (fields[key] ?? "").trim();

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

const userOption = (u: IoPerson): Option => ({
  id: u.id ?? "",
  name: u.name ?? u.email ?? u.id ?? "",
  ...(u.email ? { description: u.email } : {}),
});

function shiftRow(s: IoShift): ShiftRow {
  return {
    name: s.user?.name ?? s.user?.email ?? "",
    start: s.start_at ?? "",
    end: s.end_at ?? "",
  };
}

export class IncidentIoClient implements PluginClient {
  private readonly api: IoApi;
  private readonly paging: PagingContext;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) {
      throw new Error("incident.io plugin: enter an API key (Settings, API keys in incident.io)");
    }
    const caCert = credentials["caCert"] ?? "";
    this.api = createIoApi({
      apiKey,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    });
    this.paging = { api: this.api, sources: new Map() };
  }

  private async severities(): Promise<IoSeverity[]> {
    const path = "/v1/severities";
    const res = await this.api.get(path);
    return requireListPage(res?.severities, listPlace(path, "severities", res)).sort(
      (a, b) => (a.rank ?? 0) - (b.rank ?? 0),
    );
  }

  private async users(walk: { partial?: boolean } = {}): Promise<IoUser[]> {
    return this.api.getAll("/v2/users", "users", { ...readAll(250), ...walk });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "incident-io-incident": {
          const [open, recent] = await Promise.all([
            this.api.getAll("/v2/incidents", "incidents", {
              query: { status_category: { one_of: OPEN_CATEGORIES } },
              ...readAll(250),
            }),
            this.api.getAll("/v2/incidents", "incidents", {
              query: { updated_at: { gte: [daysAgo(RECENT_WINDOW_MS)] } },
              ...readAll(250),
            }),
          ]);
          const byId = new Map<string, IoIncident>();
          for (const i of [...recent, ...open]) if (i.id) byId.set(i.id, i);
          return [...byId.values()].map((i) => mapIncident(accountId, i));
        }
        case "incident-io-escalation": {
          // The route lists every escalation ever raised, in an order the document does
          // not state, so the newest can't be asked for and the whole of it would fail a
          // busy account. Open ones and recent changes are a list that can be read whole.
          const [open, recent] = await Promise.all([
            this.api.getAll("/v2/escalations", "escalations", {
              query: { status: { not_in: ENDED_ESCALATION_STATUSES } },
              ...readAll(50),
            }),
            this.api.getAll("/v2/escalations", "escalations", {
              query: { updated_at: { gte: [daysAgo(ESCALATION_WINDOW_MS)] } },
              ...readAll(50),
            }),
          ]);
          const byId = new Map<string, IoEscalation>();
          for (const e of [...recent, ...open]) if (e.id) byId.set(e.id, e);
          return [...byId.values()].map((e) => mapEscalation(accountId, e));
        }
        case "incident-io-alert-source":
          return (await alertSources(this.api)).map((s) => mapAlertSource(accountId, s));
        case "incident-io-alert-route":
          return (await this.api.getAll("/v2/alert_routes", "alert_routes", readAll(50))).map((r) =>
            mapAlertRoute(accountId, r),
          );
        case "incident-io-schedule":
          // Not the route's 250: the document says next_shifts empties above 25 and is
          // silent on current_shifts, which `onCallNow` reads.
          return (await this.api.getAll("/v2/schedules", "schedules", readAll(25))).map((s) =>
            mapSchedule(accountId, s),
          );
        case "incident-io-escalation-path":
          return (
            await this.api.getAll("/v2/escalation_paths", "escalation_paths", readAll(25))
          ).map((p) => mapEscalationPath(accountId, p));
        case "incident-io-severity":
          return (await this.severities()).map((s) => mapSeverity(accountId, s));
        case "incident-io-status":
          return (await incidentStatuses(this.api)).map((s) => mapIncidentStatus(accountId, s));
        case "incident-io-catalog-type": {
          const path = "/v3/catalog_types";
          const res = await this.api.get(path);
          return requireListPage(res?.catalog_types, listPlace(path, "catalog_types", res)).map(
            (t) => mapCatalogType(accountId, t),
          );
        }
        case "incident-io-workflow": {
          const path = "/v2/workflows";
          const res = await this.api.get(path);
          return requireListPage(res?.workflows, listPlace(path, "workflows", res)).map((w) =>
            mapWorkflow(accountId, w),
          );
        }
        case "incident-io-status-page":
          return (await this.api.getAll("/v2/status_pages", "status_pages", readAll(250))).map(
            (p) => mapStatusPage(accountId, p),
          );
        case "incident-io-maintenance-window":
          return (
            await this.api.getAll("/v1/maintenance_windows", "maintenance_windows", readAll(50))
          )
            .filter((w) => !w.archived_at)
            .map((w) => mapMaintenanceWindow(accountId, w));
        case "incident-io-user":
          return (await this.users()).map((u) => mapUser(accountId, u));
        case "incident-io-team":
          return (await this.api.getAll("/v3/teams", "teams", readAll(250))).map((t) =>
            mapTeam(accountId, t),
          );
        default:
          throw new Error(`incident.io plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      const id = pathEncode(ext);
      switch (typeId) {
        case "incident-io-incident": {
          const res = await this.api.get(`/v2/incidents/${id}`);
          if (!res?.incident) throw new IncidentIoApiError(404, "incident.io incident not found");
          const r = mapIncident(accountId, res.incident);
          const [statuses, severities] = await Promise.all([
            incidentStatuses(this.api).catch((): IoIncidentStatus[] => []),
            this.severities().catch((): IoSeverity[] => []),
          ]);
          const durations: DurationRow[] = (res.incident.duration_metrics ?? [])
            .filter((d) => typeof d.value_seconds === "number")
            .map((d) => ({ name: d.duration_metric?.name ?? "", seconds: d.value_seconds ?? 0 }));
          r.fields[STATUSES_KEY] = JSON.stringify(
            statuses.map((s) => ({ id: s.id ?? "", name: s.name ?? "", description: s.category })),
          );
          r.fields[SEVERITIES_KEY] = JSON.stringify(
            severities.map((s) => ({ id: s.id ?? "", name: s.name ?? "" })),
          );
          r.fields[DURATIONS_KEY] = JSON.stringify(durations);
          return r;
        }
        case "incident-io-escalation": {
          const res = await this.api.get(`/v2/escalations/${id}`);
          if (!res?.escalation)
            throw new IncidentIoApiError(404, "incident.io escalation not found");
          const r = mapEscalation(accountId, res.escalation);
          const events: EventRow[] = (res.escalation.events ?? []).map((e) => ({
            event: e.event ?? "",
            at: e.occurred_at ?? "",
            users: (e.users ?? []).map((u) => u.name ?? u.email ?? "").join(", "),
          }));
          r.fields[EVENTS_KEY] = JSON.stringify(events);
          return r;
        }
        case "incident-io-alert-source": {
          const res = await this.api.get(`/v2/alert_sources/${id}`);
          if (!res?.alert_source)
            throw new IncidentIoApiError(404, "incident.io alert source not found");
          const r = mapAlertSource(accountId, res.alert_source);
          const alerts = await this.api
            .getAll("/v2/alerts", "alerts", {
              query: { alert_source: { one_of: [ext] } },
              pageSize: 25,
              maxPages: 1,
              partial: true,
            })
            .catch(() => []);
          const rows: AlertRow[] = alerts.map((a) => ({
            title: a.title ?? "",
            status: a.status ?? "",
            key: a.deduplication_key ?? "",
            at: a.created_at ?? "",
          }));
          r.fields[ALERTS_KEY] = JSON.stringify(rows);
          return r;
        }
        case "incident-io-schedule": {
          const res = await this.api.get(`/v2/schedules/${id}`);
          if (!res?.schedule) throw new IncidentIoApiError(404, "incident.io schedule not found");
          const r = mapSchedule(accountId, res.schedule);
          const now = Date.now();
          const [entries, overrides, users] = await Promise.all([
            scheduleEntries(this.api, ext, new Date(now), new Date(now + 7 * 24 * 3600_000)).catch(
              (err: unknown): IoShift[] => {
                rethrowIncompleteList(err);
                return [];
              },
            ),
            this.api
              .getAll("/v2/schedule_overrides", "overrides", {
                query: { schedule_id: ext },
                ...readAll(250),
              })
              .catch((err: unknown) => {
                rethrowIncompleteList(err);
                return [];
              }),
            this.users({ partial: true }).catch((): IoUser[] => []),
          ]);
          const layers: Option[] = (res.schedule.config?.rotations ?? []).flatMap((rot) =>
            (rot.layers ?? []).map((layer) => ({
              id: `${rot.id ?? ""}:${layer.id ?? ""}`,
              name:
                (rot.layers?.length ?? 0) > 1
                  ? `${rot.name ?? rot.id ?? ""} / ${layer.name ?? layer.id ?? ""}`
                  : (rot.name ?? rot.id ?? ""),
            })),
          );
          const upcoming: OverrideRow[] = overrides
            .filter((o) => !o.end_at || Date.parse(o.end_at) > now)
            .map((o) => ({ id: o.id ?? "", ...shiftRow(o) }));
          r.fields[SHIFTS_KEY] = JSON.stringify(entries.map(shiftRow));
          r.fields[OVERRIDES_KEY] = JSON.stringify(upcoming);
          r.fields[USERS_KEY] = JSON.stringify(users.map(userOption));
          r.fields[LAYERS_KEY] = JSON.stringify(layers);
          return r;
        }
        case "incident-io-escalation-path": {
          const res = await this.api.get(`/v2/escalation_paths/${id}`);
          if (!res?.escalation_path) {
            throw new IncidentIoApiError(404, "incident.io escalation path not found");
          }
          const r = mapEscalationPath(accountId, res.escalation_path);
          r.fields[RESPONDERS_KEY] = JSON.stringify(
            (res.escalation_path.current_responders ?? []).map(userOption),
          );
          return r;
        }
        case "incident-io-severity": {
          const res = await this.api.get(`/v1/severities/${id}`);
          if (!res?.severity) throw new IncidentIoApiError(404, "incident.io severity not found");
          return mapSeverity(accountId, res.severity);
        }
        case "incident-io-maintenance-window": {
          const res = await this.api.get(`/v1/maintenance_windows/${id}`);
          if (!res?.maintenance_window) {
            throw new IncidentIoApiError(404, "incident.io maintenance window not found");
          }
          return mapMaintenanceWindow(accountId, res.maintenance_window);
        }
        default: {
          // The rest have no richer single read than their listing.
          const all = await runPluginEffect(this.listResources(typeId, accountId));
          const found = all.find((r) => r.externalId === ext);
          if (!found) throw new IncidentIoApiError(404, `incident.io ${typeId} not found`);
          return found;
        }
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
      if (typeId === "incident-io-alert-source") {
        const res = await this.api.get(`/v2/alert_sources/${pathEncode(ext)}`);
        if (outputKey === "secretToken") return res?.alert_source?.secret_token ?? "";
        if (outputKey === "alertEventsUrl") {
          return (
            res?.alert_source?.alert_events_url ??
            `https://api.incident.io/v2/alert_events/http/${ext}`
          );
        }
      }
      if (typeId === "incident-io-schedule" && outputKey === "scheduleId") return ext;
      if (typeId === "incident-io-status-page" && outputKey === "publicUrl") {
        const pages = await runPluginEffect(this.listResources(typeId, ""));
        return String(pages.find((p) => p.externalId === ext)?.fields["publicUrl"] ?? "");
      }
      throw new Error(
        `incident.io plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      if (typeId === "incident-io-incident") {
        const [severities, types] = await Promise.all([
          this.severities().catch((): IoSeverity[] => []),
          this.api
            .get("/v1/incident_types")
            .then((r) => r?.incident_types ?? [])
            .catch(() => []),
        ]);
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Checkout is returning 500s",
            },
            { key: "summary", label: "Summary", kind: "text", required: false, multiline: true },
            ...(severities.length > 0
              ? [
                  {
                    key: "severityId",
                    label: "Severity",
                    kind: "select" as const,
                    required: false,
                    options: severities.map((s) => ({ id: s.id ?? "", label: s.name ?? "" })),
                  },
                ]
              : []),
            ...(types.length > 0
              ? [
                  {
                    key: "incidentTypeId",
                    label: "Type",
                    kind: "select" as const,
                    required: false,
                    options: types.map((t) => ({ id: t.id ?? "", label: t.name ?? "" })),
                  },
                ]
              : []),
            {
              key: "visibility",
              label: "Visibility",
              kind: "select",
              required: true,
              defaultValue: "public",
              options: [
                {
                  id: "public",
                  label: "Public",
                  description: "Anyone in the Slack workspace can join",
                },
                { id: "private", label: "Private", description: "Invite only" },
              ],
            },
            {
              key: "mode",
              label: "Mode",
              kind: "select",
              required: false,
              defaultValue: "standard",
              options: [
                { id: "standard", label: "Real incident" },
                { id: "test", label: "Test" },
              ],
            },
          ],
        };
      }
      if (typeId === "incident-io-severity") {
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "Critical" },
            { key: "description", label: "Description", kind: "text", required: true },
            {
              key: "rank",
              label: "Rank",
              kind: "number",
              required: false,
              description: "Higher is more severe.",
            },
          ],
        };
      }
      throw new Error(`incident.io plugin: creating "${typeId}" is not supported`);
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId === "incident-io-incident") {
        const name = trimmed(fields, "name");
        if (!name) throw new Error("Give the incident a name.");
        const res = await this.api.post("/v2/incidents", {
          body: {
            idempotency_key: `infrawrench-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name,
            visibility: trimmed(fields, "visibility") || "public",
            mode: trimmed(fields, "mode") || "standard",
            ...(trimmed(fields, "summary") ? { summary: trimmed(fields, "summary") } : {}),
            ...(trimmed(fields, "severityId")
              ? { severity_id: trimmed(fields, "severityId") }
              : {}),
            ...(trimmed(fields, "incidentTypeId")
              ? { incident_type_id: trimmed(fields, "incidentTypeId") }
              : {}),
          },
        });
        if (!res?.incident) throw new Error("incident.io did not return the new incident.");
        return mapIncident(accountId, res.incident);
      }
      if (typeId === "incident-io-severity") {
        const rank = trimmed(fields, "rank");
        const res = await this.api.post("/v1/severities", {
          body: {
            name: trimmed(fields, "name"),
            description: trimmed(fields, "description"),
            ...(rank ? { rank: Number(rank) } : {}),
          },
        });
        if (!res?.severity) throw new Error("incident.io did not return the new severity.");
        return mapSeverity(accountId, res.severity);
      }
      throw new Error(`incident.io plugin: creating "${typeId}" is not supported`);
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
      if (typeId === "incident-io-incident") {
        await this.api.post(`/v2/incidents/${id}/actions/edit`, {
          body: {
            incident: {
              ...("name" in fields ? { name: trimmed(fields, "name") } : {}),
              ...("summary" in fields ? { summary: trimmed(fields, "summary") } : {}),
            },
            notify_incident_channel: true,
          },
        });
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }
      if (typeId === "incident-io-severity") {
        const current = await this.api.get(`/v1/severities/${id}`);
        const s = current?.severity;
        const rank = "rank" in fields ? Number(trimmed(fields, "rank")) : s?.rank;
        await this.api.put(`/v1/severities/${id}`, {
          body: {
            name: "name" in fields ? trimmed(fields, "name") : s?.name,
            description: "description" in fields ? trimmed(fields, "description") : s?.description,
            ...(typeof rank === "number" && Number.isFinite(rank) ? { rank } : {}),
          },
        });
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }
      throw new Error(`incident.io plugin: editing "${typeId}" is not supported`);
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "incident-io-alert-source":
          await this.api.delete(`/v2/alert_sources/${id}`);
          return;
        case "incident-io-schedule":
          await this.api.delete(`/v2/schedules/${id}`);
          return;
        case "incident-io-escalation-path":
          await this.api.delete(`/v2/escalation_paths/${id}`);
          return;
        case "incident-io-severity":
          await this.api.delete(`/v1/severities/${id}`);
          return;
        case "incident-io-maintenance-window":
          await this.api.delete(`/v1/maintenance_windows/${id}`);
          return;
        default:
          throw new Error(`incident.io plugin: deleting "${typeId}" is not supported`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      if (typeId === "incident-io-escalation" && actionId === ACTIONS.acknowledge) {
        await this.api.post(`/v2/escalations/${id}/actions/respond`, {
          body: { response: "ack" },
        });
        return;
      }
      if (typeId === "incident-io-escalation" && actionId === ACTIONS.cancel) {
        await this.api.post(`/v2/escalations/${id}/actions/cancel`);
        return;
      }
      if (typeId === "incident-io-maintenance-window" && actionId === ACTIONS.endMaintenance) {
        // `force` archives an active window, which ends it immediately.
        await this.api.delete(`/v1/maintenance_windows/${id}`, { query: { force: true } });
        return;
      }
      if (typeId === "incident-io-schedule" && actionId.startsWith(ACTIONS.deleteOverridePrefix)) {
        const overrideId = actionId.slice(ACTIONS.deleteOverridePrefix.length);
        await this.api.delete(`/v2/schedule_overrides/${pathEncode(overrideId)}`);
        return;
      }
      throw new Error(`incident.io plugin: unknown action "${actionId}" for "${typeId}"`);
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
      if (typeId === "incident-io-incident" && command === COMMANDS.postUpdate) {
        const message = (values["message"] ?? "").trim();
        if (!message) throw new Error("Write the update.");
        return this.api.post("/v2/incident_updates", {
          body: {
            incident_id: ext,
            message,
            idempotency_key: `infrawrench-${ext}-${Date.now()}`,
            ...(values["statusId"] ? { to_incident_status_id: values["statusId"] } : {}),
            ...(values["severityId"] ? { to_severity_id: values["severityId"] } : {}),
          },
        });
      }
      if (typeId === "incident-io-schedule" && command === COMMANDS.addOverride) {
        const [rotationId, layerId] = (values["layer"] ?? "").split(":");
        const user = (values["userId"] ?? "").trim();
        const start = (values["start"] ?? "").trim();
        const end = (values["end"] ?? "").trim();
        if (!rotationId || !layerId || !user || !start || !end) {
          throw new Error("Pick who, the rotation, from and to.");
        }
        if (Date.parse(end) <= Date.parse(start)) {
          throw new Error("The override must end after it starts.");
        }
        return this.api.post("/v2/schedule_overrides", {
          body: {
            schedule_id: ext,
            rotation_id: rotationId,
            layer_id: layerId,
            user: { id: user },
            start_at: start,
            end_at: end,
          },
        });
      }
      throw new Error(`incident.io plugin: unknown command "${command}" for "${typeId}"`);
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

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderIncidentIoDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderIncidentIoSidebar(resource);
  }
}
