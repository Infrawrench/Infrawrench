/**
 * Detail and sidebar rendering. `getResource` stashes what the synchronous
 * renderer needs (shifts, overrides, recent alerts, picker options) under the
 * `__…__` keys below as JSON strings.
 */
import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle } from "@infrawrench/plugin-base";

export const SHIFTS_KEY = "__shifts__";
export const OVERRIDES_KEY = "__overrides__";
export const LAYERS_KEY = "__layers__";
export const USERS_KEY = "__users__";
export const STATUSES_KEY = "__statuses__";
export const SEVERITIES_KEY = "__severities__";
export const EVENTS_KEY = "__events__";
export const ALERTS_KEY = "__alerts__";
export const DURATIONS_KEY = "__durations__";
export const RESPONDERS_KEY = "__responders__";

export const COMMANDS = {
  postUpdate: "post-update",
  addOverride: "add-override",
} as const;

export const ACTIONS = {
  acknowledge: "acknowledge",
  cancel: "cancel",
  endMaintenance: "end-now",
  deleteOverridePrefix: "delete-override:",
} as const;

export interface Option {
  id: string;
  name: string;
  description?: string;
}

export interface ShiftRow {
  name: string;
  start: string;
  end: string;
}

export interface OverrideRow extends ShiftRow {
  id: string;
}

export interface EventRow {
  event: string;
  at: string;
  users: string;
}

export interface AlertRow {
  title: string;
  status: string;
  key: string;
  at: string;
}

export interface DurationRow {
  name: string;
  seconds: number;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function kv(items: Array<[string, unknown, boolean?]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value, copyable] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text === "") continue;
    list.push({ key, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function muted(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; danger?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.danger ? { variant: "danger" as const } : {}),
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
    },
  };
}

function openUrl(label: string, url: string): ActionNode {
  return { kind: "action", label, action: { type: "open-url", url } };
}

function select(key: string, label: string, options: Option[], required = true): CreateFieldConfig {
  return {
    key,
    label,
    kind: "select",
    required,
    options: options.map((o) => ({
      id: o.id,
      label: o.name,
      ...(o.description ? { description: o.description } : {}),
    })),
  };
}

function when(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? `${new Date(t).toISOString().replace("T", " ").slice(0, 16)} UTC`
    : iso;
}

function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

function shiftsTable(rows: ShiftRow[], withDelete: boolean): SchemaNode {
  return {
    kind: "table",
    columns: [
      { key: "name", label: "Who", width: "wide" },
      { key: "start", label: "From" },
      { key: "end", label: "To" },
      ...(withDelete ? [{ key: "remove", label: "" }] : []),
    ],
    rows: rows.map<TableRow>((s) => ({
      cells: {
        name: s.name,
        start: when(s.start),
        end: when(s.end),
        ...(withDelete && "id" in s
          ? {
              remove: pluginAction(
                "Remove",
                `${ACTIONS.deleteOverridePrefix}${(s as OverrideRow).id}`,
                {
                  confirm: "Remove this override?",
                  danger: true,
                },
              ),
            }
          : {}),
      },
    })),
  };
}

function renderIncident(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const statuses = parseJson<Option[]>(f[STATUSES_KEY]) ?? [];
  const severities = parseJson<Option[]>(f[SEVERITIES_KEY]) ?? [];
  const durations = parseJson<DurationRow[]>(f[DURATIONS_KEY]) ?? [];
  const category = str(f["statusCategory"]);
  const sections: SectionNode[] = [
    section("Incident", [
      kv([
        ["Status", f["status"]],
        ["Severity", f["severity"]],
        ["Type", f["incidentType"]],
        ["Incident lead", f["lead"]],
        ["Mode", f["mode"]],
        ["Visibility", f["visibility"]],
        ["Declared", when(str(f["createdAt"]))],
        ["Reference", f["reference"], true],
      ]),
      ...(f["summary"] ? [muted(str(f["summary"]))] : []),
    ]),
  ];
  if (durations.length > 0) {
    sections.push(
      section("Durations", [
        kv(durations.map((d): [string, unknown] => [d.name, duration(d.seconds)])),
      ]),
    );
  }
  const headerActions: ActionNode[] = [];
  const fields: CreateFieldConfig[] = [
    { key: "message", label: "Update", kind: "text", required: true, multiline: true },
  ];
  if (statuses.length > 0) fields.push(select("statusId", "Move to status", statuses, false));
  if (severities.length > 0)
    fields.push(select("severityId", "Change severity", severities, false));
  headerActions.push({
    kind: "action",
    label: "Post update",
    action: {
      type: "prompt-nosql-command",
      command: COMMANDS.postUpdate,
      title: "Post an update",
      description:
        "Shared in the incident channel and on the incident's timeline. Moving status or severity here records why.",
      fields,
      submitLabel: "Post update",
    },
  });
  if (f["slackChannelUrl"])
    headerActions.push(openUrl("Open Slack channel", str(f["slackChannelUrl"])));
  if (f["callUrl"]) headerActions.push(openUrl("Join call", str(f["callUrl"])));
  if (f["permalink"]) headerActions.push(openUrl("Open in incident.io", str(f["permalink"])));
  const dot: ResourceStatus =
    category === "triage"
      ? "error"
      : category === "live" || category === "paused"
        ? "degraded"
        : "healthy";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("incident.io incident", f["severity"]),
    status: { kind: "status-dot", status: dot, label: str(f["status"]) },
    headerActions,
    sections,
  };
}

function renderEscalation(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  const events = parseJson<EventRow[]>(f[EVENTS_KEY]) ?? [];
  const open = ["pending", "triggered", "snoozed", "delayed", "pending_repeat"].includes(status);
  const headerActions: ActionNode[] = [];
  if (open) {
    headerActions.push(
      pluginAction("Acknowledge", ACTIONS.acknowledge, { success: "Acknowledged" }),
      pluginAction("Cancel", ACTIONS.cancel, {
        confirm: "Cancel this escalation? Nobody else on the path is paged.",
        success: "Escalation cancelled",
        danger: true,
      }),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("incident.io escalation", f["priority"]),
    status: {
      kind: "status-dot",
      status: open ? "error" : status === "acked" ? "degraded" : "healthy",
      label: status,
    },
    headerActions,
    sections: [
      section("Escalation", [
        kv([
          ["Status", status],
          ["Priority", f["priority"]],
          ["Alerts", f["alerts"]],
          ["Incidents", f["incidents"]],
          ["Created", when(str(f["createdAt"]))],
        ]),
      ]),
      section("History", [
        events.length === 0
          ? muted("No events yet.")
          : {
              kind: "table",
              columns: [
                { key: "at", label: "When" },
                { key: "event", label: "What" },
                { key: "users", label: "Who", width: "wide" },
              ],
              rows: events.map<TableRow>((e) => ({
                cells: { at: when(e.at), event: e.event.replace(/_/g, " "), users: e.users },
              })),
            },
      ]),
    ],
  };
}

function renderSchedule(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const shifts = parseJson<ShiftRow[]>(f[SHIFTS_KEY]) ?? [];
  const overrides = parseJson<OverrideRow[]>(f[OVERRIDES_KEY]) ?? [];
  const users = parseJson<Option[]>(f[USERS_KEY]) ?? [];
  const layers = parseJson<Option[]>(f[LAYERS_KEY]) ?? [];
  const headerActions: ActionNode[] = [];
  if (users.length > 0 && layers.length > 0) {
    headerActions.push({
      kind: "action",
      label: "Add override",
      action: {
        type: "prompt-nosql-command",
        command: COMMANDS.addOverride,
        title: "Put someone on call for a while",
        description: "The override replaces whoever the rotation has on call for that window.",
        fields: [
          select("userId", "Who", users),
          select("layer", "Rotation", layers),
          { key: "start", label: "From", kind: "datetime", required: true },
          { key: "end", label: "To", kind: "datetime", required: true },
        ],
        submitLabel: "Add override",
      },
    });
  }
  if (f["permalink"]) headerActions.push(openUrl("Edit in incident.io", str(f["permalink"])));
  return {
    title: r.displayName,
    subtitle: joinSubtitle("incident.io schedule", f["timezone"]),
    ...(f["onCallNow"]
      ? { status: { kind: "status-dot", status: "healthy", label: str(f["onCallNow"]) } }
      : {}),
    headerActions,
    sections: [
      section("On call now", [
        f["onCallNow"] ? kv([["On call", f["onCallNow"]]]) : muted("Nobody is on call right now."),
      ]),
      section("Next 7 days", [
        shifts.length === 0 ? muted("No shifts.") : shiftsTable(shifts, false),
      ]),
      section("Overrides", [
        overrides.length === 0 ? muted("No upcoming overrides.") : shiftsTable(overrides, true),
      ]),
    ],
  };
}

function renderAlertSource(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const alerts = parseJson<AlertRow[]>(f[ALERTS_KEY]) ?? [];
  const sendable = f["hasToken"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("incident.io alert source", f["sourceType"]),
    sections: [
      section("Source", [
        kv([
          ["Type", f["sourceType"]],
          [
            "Auto-resolve after",
            f["autoResolveMinutes"] ? `${str(f["autoResolveMinutes"])} min` : "",
          ],
          ["Alert source ID", r.externalId, true],
        ]),
        muted(
          sendable
            ? "Alert routing rules in Infrawrench can send alerts to this source."
            : "Only HTTP sources can receive alerts from Infrawrench.",
        ),
      ]),
      section("Recent alerts", [
        alerts.length === 0
          ? muted("No recent alerts.")
          : {
              kind: "table",
              columns: [
                { key: "title", label: "Alert", width: "wide" },
                { key: "status", label: "Status" },
                { key: "key", label: "Dedup key", mono: true },
                { key: "at", label: "At" },
              ],
              rows: alerts.map<TableRow>((a) => ({
                cells: { title: a.title, status: a.status, key: a.key, at: when(a.at) },
              })),
            },
      ]),
    ],
  };
}

function renderPath(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const responders = parseJson<Option[]>(f[RESPONDERS_KEY]) ?? [];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("incident.io escalation path", f["kind"]),
    sections: [
      section("Would page now", [
        responders.length === 0
          ? muted("Nobody would be paged right now.")
          : {
              kind: "table",
              columns: [
                { key: "name", label: "Who", width: "wide" },
                { key: "email", label: "Email" },
              ],
              rows: responders.map<TableRow>((u) => ({
                cells: { name: u.name, email: u.description ?? "" },
              })),
            },
      ]),
      section("Path", [
        kv([
          ["Levels", f["levels"]],
          ["Escalation path ID", r.externalId, true],
        ]),
      ]),
    ],
  };
}

function renderMaintenance(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("incident.io maintenance window", state),
    status: {
      kind: "status-dot",
      status: state === "active" ? "info" : state === "upcoming" ? "provisioning" : "unknown",
      label: state,
    },
    headerActions:
      state === "active"
        ? [
            pluginAction("End now", ACTIONS.endMaintenance, {
              confirm: "End this maintenance window now? Matching alerts start paging again.",
              success: "Maintenance ended",
            }),
          ]
        : [],
    sections: [
      section("Window", [
        kv([
          ["Starts", when(str(f["startAt"]))],
          ["Ends", when(str(f["endAt"]))],
        ]),
        ...(f["message"] ? [muted(str(f["message"]))] : []),
      ]),
    ],
  };
}

function simple(
  r: ResourceInstance,
  subtitle: string,
  items: Array<[string, unknown, boolean?]>,
): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle,
    headerActions: f["publicUrl"] ? [openUrl("Open status page", str(f["publicUrl"]))] : [],
    sections: [
      section("Details", [kv(items), ...(f["description"] ? [muted(str(f["description"]))] : [])]),
    ],
  };
}

export function renderIncidentIoDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "incident-io-incident":
      return renderIncident(r);
    case "incident-io-escalation":
      return renderEscalation(r);
    case "incident-io-schedule":
      return renderSchedule(r);
    case "incident-io-alert-source":
      return renderAlertSource(r);
    case "incident-io-escalation-path":
      return renderPath(r);
    case "incident-io-maintenance-window":
      return renderMaintenance(r);
    case "incident-io-alert-route":
      return simple(r, "incident.io alert route", [["Enabled", f["enabled"]]]);
    case "incident-io-severity":
      return simple(r, "incident.io severity", [["Rank", f["rank"]]]);
    case "incident-io-status":
      return simple(r, "incident.io incident status", [
        ["Category", f["category"]],
        ["Rank", f["rank"]],
      ]);
    case "incident-io-catalog-type":
      return simple(r, "incident.io catalog type", [
        ["Type name", f["typeName"], true],
        ["Entries", f["entries"]],
        ["Synced from", f["syncedFrom"]],
        ["Last synced", when(str(f["lastSyncedAt"]))],
        ["Editable", f["editable"]],
      ]);
    case "incident-io-workflow":
      return simple(r, joinSubtitle("incident.io workflow", f["state"]), [
        ["State", f["state"]],
        ["Trigger", f["trigger"]],
        ["Folder", f["folder"]],
        ["Steps", f["steps"]],
      ]);
    case "incident-io-status-page":
      return simple(r, "incident.io status page", [["Public URL", f["publicUrl"], true]]);
    case "incident-io-user":
      return simple(r, joinSubtitle("incident.io user", f["role"]), [
        ["Email", f["email"], true],
        ["Role", f["role"]],
        ["On-call seat", f["onCallSeat"]],
        ["Response seat", f["responseSeat"]],
        ["Active", f["active"]],
      ]);
    case "incident-io-team":
      return simple(r, "incident.io team", [["Members", f["members"]]]);
    default:
      return {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(f).map(([k, v]) => [k, v]))])],
      };
  }
}

export function renderIncidentIoSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "incident-io-incident": {
      const c = str(f["statusCategory"]);
      return item(
        c === "triage" ? "error" : c === "live" || c === "paused" ? "degraded" : "healthy",
        str(f["status"]) || c,
      );
    }
    case "incident-io-escalation": {
      const s = str(f["status"]);
      return item(s === "triggered" ? "error" : s === "acked" ? "degraded" : "healthy", s);
    }
    case "incident-io-workflow":
      return item(
        f["state"] === "active" ? "healthy" : f["state"] === "error" ? "error" : "info",
        str(f["state"]),
      );
    case "incident-io-alert-route":
      return item(
        f["enabled"] === false ? "info" : "healthy",
        f["enabled"] === false ? "Disabled" : "Enabled",
      );
    default:
      return item("info", str(r.resourceTypeId).replace("incident-io-", "").replace(/-/g, " "));
  }
}
