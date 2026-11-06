import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * incident.io resource types. Field names follow the public OpenAPI document
 * (`/v1/openapiV3.json`, 2026-10); each type names its endpoint.
 */

export const STATUS_CATEGORIES = [
  "triage",
  "live",
  "paused",
  "learning",
  "closed",
  "declined",
  "merged",
  "canceled",
];

/** `GET /v2/incidents`: live incidents plus those updated in the last week. */
export const IncidentResourceType = rt({
  name: "Incident",
  id: "incident-io-incident",
  iconKey: "alert",
  description:
    "Incidents that are open, and those that changed in the last week. Declare one, rename it or edit its summary, post an update, change its status or severity.",
  fields: [
    f("name", "Name"),
    f("summary", "Summary", { required: false }),
    f("reference", "Reference", { required: false, editable: false }),
    f("status", "Status", { showcase: true, required: false, editable: false }),
    f("statusCategory", "Status Category", {
      kind: "enum",
      enumValues: STATUS_CATEGORIES,
      required: false,
      editable: false,
    }),
    f("severity", "Severity", { showcase: true, required: false, editable: false }),
    f("incidentType", "Type", { required: false, editable: false }),
    f("mode", "Mode", { showcase: true, required: false, editable: false }),
    f("visibility", "Visibility", { showcase: true, required: false, editable: false }),
    f("lead", "Incident Lead", { required: false, editable: false }),
    f("slackChannelUrl", "Slack Channel", { required: false, editable: false }),
    f("createdAt", "Declared", { required: false, editable: false }),
    f("permalink", "incident.io URL", { required: false, editable: false }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
});

/** `GET /v2/escalations`: pages sent by on-call. */
export const EscalationResourceType = rt({
  name: "Escalation",
  id: "incident-io-escalation",
  iconKey: "bell",
  description:
    "A page incident.io On-call sent down an escalation path. Acknowledge or cancel it from here.",
  fields: [
    f("title", "Title"),
    f("status", "Status", { showcase: true, required: false }),
    f("priority", "Priority", { showcase: true, required: false }),
    f("alerts", "Alerts", { required: false }),
    f("incidents", "Incidents", { required: false }),
    f("createdAt", "Created", { showcase: true, required: false }),
  ],
  pinnable: false,
});

/** `GET /v2/alert_sources`. */
export const AlertSourceResourceType = rt({
  name: "Alert Source",
  id: "incident-io-alert-source",
  iconKey: "plug",
  description:
    "Where alerts come into incident.io. HTTP sources can receive Infrawrench alerts from an alert routing rule.",
  fields: [
    f("name", "Name"),
    f("sourceType", "Source Type", { required: false }),
    f("autoResolveMinutes", "Auto-resolve After (minutes)", { kind: "number", required: false }),
    f("hasToken", "Has a Secret Token", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("alertEventsUrl", "Alert Events URL", {
      description: "POST alert events here (HTTP sources).",
    }),
    o("secretToken", "Secret Token", {
      sensitive: true,
      description: "Send as the bearer token with each alert event.",
    }),
  ],
  supportsDelete: true,
});

/** `GET /v2/alert_routes`. */
export const AlertRouteResourceType = rt({
  name: "Alert Route",
  id: "incident-io-alert-route",
  iconKey: "route",
  description: "How alerts become escalations and incidents. Edited in incident.io.",
  fields: [f("name", "Name"), f("enabled", "Enabled", { kind: "boolean", required: false })],
  pinnable: false,
});

/** `GET /v2/schedules`, `GET /v2/schedule_entries` for the next week. */
export const ScheduleResourceType = rt({
  name: "Schedule",
  id: "incident-io-schedule",
  iconKey: "calendar",
  description:
    "An on-call schedule. See who is on call now and for the next week, and add overrides.",
  fields: [
    f("name", "Name"),
    f("timezone", "Time Zone", { required: false }),
    f("onCallNow", "On Call Now", { required: false }),
    f("rotations", "Rotations", { kind: "number", required: false }),
    f("permalink", "incident.io URL", { required: false }),
  ],
  outputs: [o("scheduleId", "Schedule ID")],
  supportsDelete: true,
});

/** `GET /v2/escalation_paths`. */
export const EscalationPathResourceType = rt({
  name: "Escalation Path",
  plural: "Escalation Paths",
  id: "incident-io-escalation-path",
  iconKey: "route",
  description: "Who an alert pages, level by level. Shows who would be paged right now.",
  fields: [
    f("name", "Name"),
    f("kind", "Kind", { showcase: true, required: false }),
    f("currentResponders", "Would Page Now", { required: false }),
    f("levels", "Levels", { kind: "number", required: false }),
  ],
  supportsDelete: true,
});

/** `GET /v1/severities`. */
export const SeverityResourceType = rt({
  name: "Severity",
  plural: "Severities",
  id: "incident-io-severity",
  iconKey: "flag",
  description: "The severities an incident can have, ranked. Edit names, descriptions and ranks.",
  fields: [
    f("name", "Name"),
    f("rank", "Rank", {
      kind: "number",
      required: false,
      description: "Higher is more severe.",
    }),
    f("description", "Description", { required: false }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

/** `GET /v1/incident_statuses`. */
export const StatusResourceType = rt({
  name: "Incident Status",
  plural: "Incident Statuses",
  id: "incident-io-status",
  iconKey: "activity",
  description: "The statuses an incident moves through, by category.",
  fields: [
    f("name", "Name"),
    f("category", "Category", {
      showcase: true,
      kind: "enum",
      enumValues: STATUS_CATEGORIES,
      required: false,
    }),
    f("rank", "Rank", { kind: "number", required: false }),
    f("description", "Description", { required: false }),
  ],
  pinnable: false,
});

/** `GET /v3/catalog_types`. */
export const CatalogTypeResourceType = rt({
  name: "Catalog Type",
  id: "incident-io-catalog-type",
  iconKey: "catalog",
  description: "A kind of thing in the incident.io catalog (services, teams, customers).",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("typeName", "Type Name", { required: false }),
    f("entries", "Entries", { kind: "number", required: false }),
    f("syncedFrom", "Synced From", { required: false }),
    f("lastSyncedAt", "Last Synced", { required: false }),
    f("editable", "Editable", { kind: "boolean", required: false }),
  ],
  pinnable: false,
});

/** `GET /v2/workflows`. */
export const WorkflowResourceType = rt({
  name: "Workflow",
  id: "incident-io-workflow",
  iconKey: "workflow",
  description: "Automation that runs when incidents change. Edited in incident.io.",
  fields: [
    f("name", "Name"),
    f("state", "State", {
      showcase: true,
      kind: "enum",
      enumValues: ["active", "disabled", "draft", "error"],
      required: false,
    }),
    f("trigger", "Trigger", { required: false }),
    f("folder", "Folder", { required: false }),
    f("steps", "Steps", { required: false }),
  ],
  pinnable: false,
});

/** `GET /v2/status_pages`. */
export const StatusPageResourceType = rt({
  name: "Status Page",
  id: "incident-io-status-page",
  iconKey: "activity",
  description: "A public status page hosted by incident.io.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("publicUrl", "Public URL", { required: false }),
  ],
  outputs: [o("publicUrl", "Public URL")],
});

/** `GET /v1/maintenance_windows`. */
export const MaintenanceWindowResourceType = rt({
  name: "Maintenance Window",
  id: "incident-io-maintenance-window",
  iconKey: "clock",
  description: "A window during which matching alerts do not page. End one early from here.",
  fields: [
    f("name", "Name"),
    f("startAt", "Starts", { required: false }),
    f("endAt", "Ends", { required: false }),
    f("state", "State", {
      showcase: true,
      kind: "enum",
      enumValues: ["upcoming", "active", "past"],
      required: false,
    }),
    f("message", "Notification Message", { required: false }),
  ],
  supportsDelete: true,
  pinnable: false,
});

/** `GET /v2/users`. */
export const UserResourceType = rt({
  name: "User",
  id: "incident-io-user",
  iconKey: "user",
  description: "People in incident.io, matched to Infrawrench members by email for on-call.",
  fields: [
    f("name", "Name"),
    f("email", "Email", { required: false }),
    f("role", "Role", { showcase: true, required: false }),
    f("onCallSeat", "On-call Seat", { required: false }),
    f("responseSeat", "Response Seat", { required: false }),
    f("active", "Active", { kind: "boolean", required: false }),
  ],
  pinnable: false,
});

/** `GET /v3/teams`. */
export const TeamResourceType = rt({
  name: "Team",
  id: "incident-io-team",
  iconKey: "team",
  description: "Teams that own incidents, schedules and escalation paths.",
  fields: [
    f("name", "Name"),
    f("members", "Members", { showcase: true, kind: "number", required: false }),
  ],
  pinnable: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  IncidentResourceType,
  EscalationResourceType,
  AlertSourceResourceType,
  AlertRouteResourceType,
  ScheduleResourceType,
  EscalationPathResourceType,
  SeverityResourceType,
  StatusResourceType,
  CatalogTypeResourceType,
  WorkflowResourceType,
  StatusPageResourceType,
  MaintenanceWindowResourceType,
  UserResourceType,
  TeamResourceType,
];
