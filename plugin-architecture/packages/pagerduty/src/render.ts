/**
 * Detail and sidebar rendering. `getResource` stashes what the synchronous
 * renderer needs (on-call now, upcoming shifts, overrides, notes, picker
 * options) under the `__…__` keys below as JSON strings.
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
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { METRICS_WINDOW_MS } from "./metrics.js";
import type { ServiceAnalyticsRow } from "./metrics.js";
import { RESOURCE_TYPES, URGENCIES } from "./resource-types.js";

export const ONCALL_KEY = "__oncall__";
export const SHIFTS_KEY = "__shifts__";
export const OVERRIDES_KEY = "__overrides__";
export const NOTES_KEY = "__notes__";
export const ALERTS_KEY = "__alerts__";
export const INTEGRATIONS_KEY = "__integrations__";
export const SUMMARY_KEY = "__summary__";
export const OPEN_INCIDENTS_KEY = "__openIncidents__";
export const USERS_KEY = "__users__";
export const POLICIES_KEY = "__policies__";
export const PRIORITIES_KEY = "__priorities__";
export const SERVICES_KEY = "__services__";

export const COMMANDS = {
  createIncident: "create-incident",
  changeEscalationPolicy: "change-escalation-policy",
  reassign: "reassign",
  addNote: "add-note",
  snooze: "snooze",
  setUrgency: "set-urgency",
  setPriority: "set-priority",
  addOverride: "add-override",
  endMaintenance: "end-maintenance",
} as const;

export const ACTIONS = {
  acknowledge: "acknowledge",
  resolve: "resolve",
  disable: "disable",
  enable: "enable",
  deleteOverridePrefix: "delete-override:",
} as const;

export interface Option {
  id: string;
  name: string;
  description?: string;
}

export interface OnCallRow {
  level: number;
  name: string;
  email: string;
  schedule: string;
  until: string;
}

export interface ShiftRow {
  name: string;
  start: string;
  end: string;
}

export interface OverrideRow extends ShiftRow {
  id: string;
}

export interface NoteRow {
  at: string;
  who: string;
  content: string;
}

export interface AlertRow {
  key: string;
  status: string;
  summary: string;
  at: string;
}

export interface IntegrationRow {
  id: string;
  name: string;
  type: string;
}

export interface IncidentRow {
  id: string;
  ref: string;
  title: string;
  status: string;
  urgency: string;
  at: string;
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
  opts: { confirm?: string; success?: string; danger?: boolean; destructive?: boolean } = {},
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
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function prompt(
  label: string,
  command: string,
  title: string,
  fields: CreateFieldConfig[],
  opts: { description?: string; submitLabel?: string } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "prompt-nosql-command",
      command,
      title,
      ...(opts.description ? { description: opts.description } : {}),
      fields,
      ...(opts.submitLabel ? { submitLabel: opts.submitLabel } : {}),
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

function text(
  key: string,
  label: string,
  opts: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return { key, label, kind: "text", required: true, ...opts };
}

function when(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : iso;
}

function onCallTable(rows: OnCallRow[] | undefined, empty: string): SchemaNode {
  if (!rows || rows.length === 0) return muted(empty);
  return {
    kind: "table",
    columns: [
      { key: "level", label: "Level", width: "narrow" },
      { key: "name", label: "On call", width: "wide" },
      { key: "schedule", label: "Via" },
      { key: "until", label: "Until" },
    ],
    rows: rows.map<TableRow>((r) => ({
      cells: {
        level: String(r.level),
        name: r.email ? `${r.name} (${r.email})` : r.name,
        schedule: r.schedule || "Direct",
        until: r.until ? when(r.until) : "Permanently",
      },
    })),
  };
}

function minutes(v: unknown): string {
  return typeof v === "number" ? `${v} min` : "Off";
}

function renderService(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const disabled = f["status"] === "disabled";
  const summary = parseJson<ServiceAnalyticsRow>(f[SUMMARY_KEY]);
  const incidents = parseJson<IncidentRow[]>(f[OPEN_INCIDENTS_KEY]) ?? [];
  const integrations = parseJson<IntegrationRow[]>(f[INTEGRATIONS_KEY]) ?? [];
  const policies = parseJson<Option[]>(f[POLICIES_KEY]) ?? [];
  const priorities = parseJson<Option[]>(f[PRIORITIES_KEY]) ?? [];

  const sections: SectionNode[] = [
    section("Service", [
      kv([
        ["Status", f["status"]],
        ["Escalation policy", f["escalationPolicyName"]],
        ["Auto-resolve after", minutes(f["autoResolveMinutes"])],
        ["Re-trigger after acknowledgement", minutes(f["acknowledgementTimeoutMinutes"])],
        ["Incident urgency", f["urgency"]],
        ["Alert creation", f["alertCreation"]],
        ["Teams", f["teams"]],
        ["Last incident", when(str(f["lastIncidentAt"]))],
        ["Service ID", r.externalId, true],
      ]),
      ...(f["description"] ? [muted(str(f["description"]))] : []),
    ]),
    section("On call now", [
      onCallTable(parseJson<OnCallRow[]>(f[ONCALL_KEY]), "Nobody is on call for this service."),
    ]),
  ];

  if (summary) {
    const mtta = summary.mean_seconds_to_first_ack;
    const mttr = summary.mean_seconds_to_resolve;
    sections.push(
      section("Last 30 days", [
        kv([
          ["Incidents", summary.total_incident_count],
          [
            "Mean time to acknowledge",
            typeof mtta === "number" ? `${Math.round(mtta / 60)} min` : "",
          ],
          ["Mean time to resolve", typeof mttr === "number" ? `${Math.round(mttr / 60)} min` : ""],
          [
            "Uptime",
            typeof summary.up_time_pct === "number" ? `${summary.up_time_pct.toFixed(2)}%` : "",
          ],
          ["Escalations", summary.total_escalation_count],
          ["Interruptions", summary.total_interruptions],
          ["Off-hours interruptions", summary.total_off_hour_interruptions],
          ["Sleep-hours interruptions", summary.total_sleep_hour_interruptions],
          ["Notifications sent", summary.total_notifications],
        ]),
      ]),
    );
  }

  sections.push(
    section("Open incidents", [
      incidents.length === 0
        ? muted("No open incidents.")
        : {
            kind: "table",
            columns: [
              { key: "ref", label: "#", width: "narrow" },
              { key: "title", label: "Title", width: "wide" },
              { key: "status", label: "Status" },
              { key: "urgency", label: "Urgency" },
              { key: "at", label: "Opened" },
            ],
            rows: incidents.map<TableRow>((i) => ({
              cells: {
                ref: i.ref,
                title: i.title,
                status: i.status,
                urgency: i.urgency,
                at: when(i.at),
              },
            })),
          },
    ]),
    section("Integrations", [
      integrations.length === 0
        ? muted(
            "No integrations. Infrawrench adds an Events API v2 integration the first time an alert routing rule sends here.",
          )
        : {
            kind: "table",
            columns: [
              { key: "name", label: "Name", width: "wide" },
              { key: "type", label: "Type" },
            ],
            rows: integrations.map<TableRow>((i) => ({
              cells: {
                name: i.name,
                type: i.type.replace(/_inbound_integration(_reference)?$/, ""),
              },
            })),
          },
    ]),
  );

  const headerActions: ActionNode[] = [
    prompt(
      "Open incident",
      COMMANDS.createIncident,
      "Open an incident on this service",
      [
        text("title", "Title", { placeholder: "Checkout is returning 500s" }),
        select(
          "urgency",
          "Urgency",
          URGENCIES.map((u) => ({ id: u, name: u === "high" ? "High (pages now)" : "Low" })),
          false,
        ),
        ...(priorities.length > 0 ? [select("priorityId", "Priority", priorities, false)] : []),
        text("details", "Details", { required: false, multiline: true }),
      ],
      {
        description:
          "PagerDuty pages the service's escalation policy. You are recorded as the reporter.",
        submitLabel: "Open incident",
      },
    ),
  ];
  if (policies.length > 0) {
    headerActions.push(
      prompt(
        "Change escalation policy",
        COMMANDS.changeEscalationPolicy,
        "Change who this service pages",
        [select("escalationPolicyId", "Escalation policy", policies)],
        { submitLabel: "Change" },
      ),
    );
  }
  headerActions.push(
    disabled
      ? pluginAction("Enable", ACTIONS.enable, { success: "Service enabled" })
      : pluginAction("Disable", ACTIONS.disable, {
          confirm: "A disabled service opens no incidents and pages nobody. Disable it?",
          success: "Service disabled",
          danger: true,
        }),
  );
  if (f["htmlUrl"]) headerActions.push(openUrl("Open in PagerDuty", str(f["htmlUrl"])));

  const status: ResourceStatus =
    f["status"] === "critical"
      ? "error"
      : f["status"] === "warning"
        ? "degraded"
        : f["status"] === "disabled" || f["status"] === "maintenance"
          ? "info"
          : "healthy";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("PagerDuty service", f["escalationPolicyName"]),
    status: { kind: "status-dot", status, label: str(f["status"]) || "active" },
    headerActions,
    sections,
  };
}

function renderPolicy(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const rules =
    parseJson<Array<{ delay?: number; targets?: Array<{ name?: string; type?: string }> }>>(
      f["rulesJson"],
    ) ?? [];
  const sections: SectionNode[] = [
    section("On call now", [
      onCallTable(parseJson<OnCallRow[]>(f[ONCALL_KEY]), "Nobody is on call on this policy."),
    ]),
    section("Levels", [
      rules.length === 0
        ? muted("No levels.")
        : {
            kind: "table",
            columns: [
              { key: "level", label: "Level", width: "narrow" },
              { key: "targets", label: "Notifies", width: "wide" },
              { key: "delay", label: "Then escalates after" },
            ],
            rows: rules.map<TableRow>((rule, i) => ({
              cells: {
                level: String(i + 1),
                targets: (rule.targets ?? [])
                  .map(
                    (t) => `${t.name ?? ""}${t.type?.startsWith("schedule") ? " (schedule)" : ""}`,
                  )
                  .join(", "),
                delay: typeof rule.delay === "number" ? `${rule.delay} min` : "",
              },
            })),
          },
      kv([
        ["Repeats", f["numLoops"]],
        ["Services", f["services"]],
        ["Teams", f["teams"]],
        ["Escalation policy ID", r.externalId, true],
      ]),
    ]),
  ];
  const headerActions: ActionNode[] = [];
  if (f["htmlUrl"]) headerActions.push(openUrl("Open in PagerDuty", str(f["htmlUrl"])));
  return {
    title: r.displayName,
    subtitle: joinSubtitle("PagerDuty escalation policy", `${str(f["levels"])} levels`),
    headerActions,
    sections,
  };
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
                { confirm: "Remove this override?", danger: true },
              ),
            }
          : {}),
      },
    })),
  };
}

function renderSchedule(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const shifts = parseJson<ShiftRow[]>(f[SHIFTS_KEY]) ?? [];
  const overrides = parseJson<OverrideRow[]>(f[OVERRIDES_KEY]) ?? [];
  const users = parseJson<Option[]>(f[USERS_KEY]) ?? [];
  const current = shifts.find(
    (s) => Date.parse(s.start) <= Date.now() && Date.parse(s.end) > Date.now(),
  );
  const sections: SectionNode[] = [
    section("On call now", [
      current
        ? kv([
            ["On call", current.name],
            ["Until", when(current.end)],
          ])
        : muted("Nobody is on call right now."),
    ]),
    section("Next 7 days", [
      shifts.length === 0 ? muted("No shifts.") : shiftsTable(shifts, false),
    ]),
    section("Overrides (next 30 days)", [
      overrides.length === 0 ? muted("No overrides.") : shiftsTable(overrides, true),
    ]),
    section("Schedule", [
      kv([
        ["Time zone", f["timeZone"]],
        ["People", f["users"]],
        ["Used by", f["escalationPolicies"]],
        ["Teams", f["teams"]],
        ["Schedule ID", r.externalId, true],
      ]),
      ...(f["description"] ? [muted(str(f["description"]))] : []),
    ]),
  ];
  const headerActions: ActionNode[] = [];
  if (users.length > 0) {
    headerActions.push(
      prompt(
        "Add override",
        COMMANDS.addOverride,
        "Put someone on call for a while",
        [
          select("userId", "Who", users),
          { key: "start", label: "From", kind: "datetime", required: true },
          { key: "end", label: "To", kind: "datetime", required: true },
        ],
        {
          description: "The override replaces whoever the rotation has on call for that window.",
          submitLabel: "Add override",
        },
      ),
    );
  }
  if (f["htmlUrl"]) headerActions.push(openUrl("Edit rotation in PagerDuty", str(f["htmlUrl"])));
  return {
    title: r.displayName,
    subtitle: joinSubtitle("PagerDuty schedule", f["timeZone"]),
    ...(current ? { status: { kind: "status-dot", status: "healthy", label: current.name } } : {}),
    headerActions,
    sections,
  };
}

function renderIncident(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  const notes = parseJson<NoteRow[]>(f[NOTES_KEY]) ?? [];
  const alerts = parseJson<AlertRow[]>(f[ALERTS_KEY]) ?? [];
  const users = parseJson<Option[]>(f[USERS_KEY]) ?? [];
  const policies = parseJson<Option[]>(f[POLICIES_KEY]) ?? [];
  const priorities = parseJson<Option[]>(f[PRIORITIES_KEY]) ?? [];

  const sections: SectionNode[] = [
    section("Incident", [
      kv([
        ["Status", status],
        ["Urgency", f["urgency"]],
        ["Priority", f["priority"]],
        ["Service", f["serviceName"]],
        ["Escalation policy", f["escalationPolicyName"]],
        ["Assigned to", f["assignees"]],
        ["Opened", when(str(f["createdAt"]))],
        ["Resolved", when(str(f["resolvedAt"]))],
        ["Incident key", f["incidentKey"], true],
      ]),
    ]),
    section("Alerts", [
      alerts.length === 0
        ? muted("No alerts.")
        : {
            kind: "table",
            columns: [
              { key: "summary", label: "Alert", width: "wide" },
              { key: "status", label: "Status" },
              { key: "key", label: "Dedup key", mono: true },
              { key: "at", label: "At" },
            ],
            rows: alerts.map<TableRow>((a) => ({
              cells: { summary: a.summary, status: a.status, key: a.key, at: when(a.at) },
            })),
          },
    ]),
    section("Notes", [
      notes.length === 0
        ? muted("No notes yet.")
        : {
            kind: "table",
            columns: [
              { key: "at", label: "When" },
              { key: "who", label: "Who" },
              { key: "content", label: "Note", width: "wide" },
            ],
            rows: notes.map<TableRow>((n) => ({
              cells: { at: when(n.at), who: n.who, content: n.content },
            })),
          },
    ]),
  ];

  const headerActions: ActionNode[] = [];
  if (status === "triggered") {
    headerActions.push(
      pluginAction("Acknowledge", ACTIONS.acknowledge, { success: "Acknowledged" }),
    );
  }
  if (status !== "resolved") {
    headerActions.push(
      pluginAction("Resolve", ACTIONS.resolve, {
        confirm: "Resolve this incident in PagerDuty?",
        success: "Resolved",
      }),
    );
    const assignTo: Option[] = [
      ...users.map((u) => ({ ...u, id: `user:${u.id}`, description: u.description ?? "Person" })),
      ...policies.map((p) => ({ ...p, id: `policy:${p.id}`, description: "Escalation policy" })),
    ];
    if (assignTo.length > 0) {
      headerActions.push(
        prompt("Reassign", COMMANDS.reassign, "Reassign this incident", [
          select("assignee", "Assign to", assignTo),
        ]),
      );
    }
    headerActions.push(
      prompt(
        "Snooze",
        COMMANDS.snooze,
        "Snooze this incident",
        [
          select("minutes", "For", [
            { id: "30", name: "30 minutes" },
            { id: "60", name: "1 hour" },
            { id: "240", name: "4 hours" },
            { id: "1440", name: "1 day" },
          ]),
        ],
        { description: "It goes back to triggered when the snooze ends.", submitLabel: "Snooze" },
      ),
      prompt("Change urgency", COMMANDS.setUrgency, "Change urgency", [
        select(
          "urgency",
          "Urgency",
          URGENCIES.map((u) => ({ id: u, name: u })),
        ),
      ]),
    );
    if (priorities.length > 0) {
      headerActions.push(
        prompt("Set priority", COMMANDS.setPriority, "Set priority", [
          select("priorityId", "Priority", priorities),
        ]),
      );
    }
  }
  headerActions.push(
    prompt("Add note", COMMANDS.addNote, "Add a note", [
      text("content", "Note", { multiline: true }),
    ]),
  );
  if (f["htmlUrl"]) headerActions.push(openUrl("Open in PagerDuty", str(f["htmlUrl"])));

  const dot: ResourceStatus =
    status === "triggered" ? "error" : status === "acknowledged" ? "degraded" : "healthy";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("PagerDuty incident", f["serviceName"]),
    status: { kind: "status-dot", status: dot, label: status },
    headerActions,
    sections,
  };
}

function renderMaintenance(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  const headerActions: ActionNode[] = [];
  if (state === "ongoing") {
    headerActions.push(
      pluginAction("End now", COMMANDS.endMaintenance, {
        confirm: "End this maintenance window now? The services start opening incidents again.",
        success: "Maintenance ended",
      }),
    );
  }
  if (f["htmlUrl"]) headerActions.push(openUrl("Open in PagerDuty", str(f["htmlUrl"])));
  return {
    title: r.displayName,
    subtitle: joinSubtitle("PagerDuty maintenance window", state),
    status: {
      kind: "status-dot",
      status: state === "ongoing" ? "info" : state === "upcoming" ? "provisioning" : "unknown",
      label: state,
    },
    headerActions,
    sections: [
      section("Window", [
        kv([
          ["Starts", when(str(f["startTime"]))],
          ["Ends", when(str(f["endTime"]))],
          ["Services", f["services"]],
          ["Created by", f["createdBy"]],
        ]),
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
  const headerActions: ActionNode[] = [];
  if (f["htmlUrl"]) headerActions.push(openUrl("Open in PagerDuty", str(f["htmlUrl"])));
  return {
    title: r.displayName,
    subtitle,
    headerActions,
    sections: [
      section("Details", [kv(items), ...(f["description"] ? [muted(str(f["description"]))] : [])]),
    ],
  };
}

export function renderPagerDutyDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "pagerduty-service":
      schema = renderService(r);
      break;
    case "pagerduty-escalation-policy":
      schema = renderPolicy(r);
      break;
    case "pagerduty-schedule":
      schema = renderSchedule(r);
      break;
    case "pagerduty-incident":
      schema = renderIncident(r);
      break;
    case "pagerduty-maintenance-window":
      schema = renderMaintenance(r);
      break;
    case "pagerduty-team":
      schema = simple(r, "PagerDuty team", [
        ["Parent team", f["parentTeam"]],
        ["Team ID", r.externalId, true],
      ]);
      break;
    case "pagerduty-user":
      schema = simple(r, joinSubtitle("PagerDuty user", f["role"]), [
        ["Email", f["email"], true],
        ["Role", f["role"]],
        ["Job title", f["jobTitle"]],
        ["Time zone", f["timeZone"]],
        ["Teams", f["teams"]],
        ["Invitation pending", f["invitationPending"]],
      ]);
      break;
    case "pagerduty-business-service":
      schema = simple(r, "PagerDuty business service", [
        ["Point of contact", f["pointOfContact"]],
        ["Owning team", f["teamName"]],
        ["Business service ID", r.externalId, true],
      ]);
      break;
    case "pagerduty-event-orchestration":
      schema = simple(r, "PagerDuty event orchestration", [
        ["Routes", f["routes"]],
        ["Team", f["teamName"]],
        ["Updated", when(str(f["updatedAt"]))],
        ["Orchestration ID", r.externalId, true],
      ]);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(f).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderPagerDutySidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "pagerduty-service": {
      const s = str(f["status"]);
      return item(
        s === "critical"
          ? "error"
          : s === "warning"
            ? "degraded"
            : s === "active"
              ? "healthy"
              : "info",
        s || "Service",
      );
    }
    case "pagerduty-incident": {
      const s = str(f["status"]);
      return item(s === "triggered" ? "error" : s === "acknowledged" ? "degraded" : "healthy", s);
    }
    case "pagerduty-maintenance-window":
      return item(f["state"] === "ongoing" ? "info" : "unknown", str(f["state"]));
    default:
      return item("info", str(r.resourceTypeId).replace("pagerduty-", "").replace(/-/g, " "));
  }
}
