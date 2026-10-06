import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * PagerDuty resource types. Field names follow the REST API v2 OpenAPI
 * document (2026-10); each type names its endpoint.
 */

export const URGENCIES = ["high", "low"];
export const ALERT_CREATION = ["create_alerts_and_incidents", "create_incidents"];
export const SERVICE_STATUSES = ["active", "warning", "critical", "maintenance", "disabled"];

/** `GET /services?include[]=integrations&include[]=teams`. */
export const ServiceResourceType = rt({
  name: "Service",
  id: "pagerduty-service",
  description:
    "Something PagerDuty pages about: incidents open on a service and go to its escalation policy. Edit timeouts and urgency, change the escalation policy, open an incident, disable or re-enable it, and chart incidents, time to acknowledge and time to resolve.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: SERVICE_STATUSES,
      required: false,
      editable: false,
    }),
    f("escalationPolicyName", "Escalation Policy", { required: false, editable: false }),
    f("autoResolveMinutes", "Auto-resolve After (minutes)", {
      kind: "number",
      required: false,
      description: "Resolve an incident left open this long. Empty turns auto-resolve off.",
    }),
    f("acknowledgementTimeoutMinutes", "Re-trigger After Acknowledgement (minutes)", {
      kind: "number",
      required: false,
      description:
        "An acknowledged incident goes back to triggered after this long. Empty turns it off.",
    }),
    f("urgency", "Incident Urgency", {
      kind: "enum",
      enumValues: [...URGENCIES, "use_support_hours", "severity_based"],
      required: false,
      editable: false,
    }),
    f("alertCreation", "Alert Creation", {
      kind: "enum",
      enumValues: ALERT_CREATION,
      required: false,
      editable: false,
    }),
    f("teams", "Teams", { required: false, editable: false }),
    f("integrationCount", "Integrations", { kind: "number", required: false, editable: false }),
    f("lastIncidentAt", "Last Incident", { required: false, editable: false }),
    f("htmlUrl", "PagerDuty URL", { required: false, editable: false }),
  ],
  outputs: [
    o("serviceId", "Service ID"),
    o("eventsRoutingKey", "Events API v2 Routing Key", {
      sensitive: true,
      description:
        "The integration key of the service's Events API v2 integration, for monitoring tools that send events (Alertmanager, Grafana, CloudWatch). Empty until the service has one; Infrawrench creates one the first time an alert routing rule sends here.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
});

/** `GET /escalation_policies`. */
export const EscalationPolicyResourceType = rt({
  name: "Escalation Policy",
  plural: "Escalation Policies",
  id: "pagerduty-escalation-policy",
  description:
    "Who is notified, in which order and after how long. See who is on call at each level right now.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("numLoops", "Repeat Times", {
      kind: "number",
      required: false,
      description: "How many times the whole policy repeats if nobody acknowledges (0-9).",
    }),
    f("levels", "Levels", { kind: "number", required: false, editable: false }),
    f("firstLevelTargets", "First Level", { required: false, editable: false }),
    f("services", "Services", { required: false, editable: false }),
    f("teams", "Teams", { required: false, editable: false }),
    f("htmlUrl", "PagerDuty URL", { required: false, editable: false }),
  ],
  outputs: [o("escalationPolicyId", "Escalation Policy ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

/** `GET /schedules`, with `GET /schedules/{id}` for the rendered final schedule. */
export const ScheduleResourceType = rt({
  name: "Schedule",
  id: "pagerduty-schedule",
  description:
    "An on-call rotation. See who is on call now and for the next week, and add or remove overrides.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("timeZone", "Time Zone", { required: false, editable: false }),
    f("users", "People", { required: false, editable: false }),
    f("escalationPolicies", "Used By", { required: false, editable: false }),
    f("teams", "Teams", { required: false, editable: false }),
    f("htmlUrl", "PagerDuty URL", { required: false, editable: false }),
  ],
  outputs: [o("scheduleId", "Schedule ID")],
  // No `supportsUpdate`: PUT /schedules/{id} replaces every layer, and the
  // layers are edited in PagerDuty's own schedule editor. Overrides, which
  // are what changes week to week, are actions here.
  supportsDelete: true,
});

/** `GET /teams`. */
export const TeamResourceType = rt({
  name: "Team",
  id: "pagerduty-team",
  description: "A group of people, with the services and policies they own.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("parentTeam", "Parent Team", { required: false, editable: false }),
    f("htmlUrl", "PagerDuty URL", { required: false, editable: false }),
  ],
  outputs: [o("teamId", "Team ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

/** `GET /users?include[]=teams`. */
export const UserResourceType = rt({
  name: "User",
  id: "pagerduty-user",
  description: "Somebody PagerDuty can page. Matched to Infrawrench members by email for on-call.",
  fields: [
    f("name", "Name"),
    f("email", "Email"),
    f("role", "Role", { required: false }),
    f("timeZone", "Time Zone", { required: false }),
    f("jobTitle", "Job Title", { required: false }),
    f("teams", "Teams", { required: false }),
    f("invitationPending", "Invitation Pending", { kind: "boolean", required: false }),
    f("htmlUrl", "PagerDuty URL", { required: false }),
  ],
  pinnable: false,
});

/** `GET /incidents?statuses[]=triggered&statuses[]=acknowledged` plus the last week's resolved. */
export const IncidentResourceType = rt({
  name: "Incident",
  id: "pagerduty-incident",
  description:
    "Open incidents, and those resolved in the last week. Acknowledge, resolve, reassign, snooze, change urgency or priority, and add notes.",
  parentTypeId: "pagerduty-service",
  fields: [
    f("title", "Title"),
    f("number", "Number", { kind: "number", required: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["triggered", "acknowledged", "resolved"],
      required: false,
    }),
    f("urgency", "Urgency", { kind: "enum", enumValues: URGENCIES, required: false }),
    f("priority", "Priority", { required: false }),
    f("serviceName", "Service", { required: false }),
    f("escalationPolicyName", "Escalation Policy", { required: false }),
    f("assignees", "Assigned To", { required: false }),
    f("incidentKey", "Incident Key", {
      required: false,
      description: "The dedup key of the alert that opened it.",
    }),
    f("createdAt", "Opened", { required: false }),
    f("resolvedAt", "Resolved", { required: false }),
    f("htmlUrl", "PagerDuty URL", { required: false }),
  ],
  pinnable: false,
});

/** `GET /maintenance_windows?filter=open` (ongoing and upcoming). */
export const MaintenanceWindowResourceType = rt({
  name: "Maintenance Window",
  id: "pagerduty-maintenance-window",
  description:
    "A window during which the chosen services open no incidents. Schedule one, move its end, or end it early.",
  fields: [
    f("description", "Description", { required: false }),
    f("startTime", "Starts", { required: false }),
    f("endTime", "Ends", { required: false }),
    f("state", "State", {
      kind: "enum",
      enumValues: ["upcoming", "ongoing", "past"],
      required: false,
      editable: false,
    }),
    f("services", "Services", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("htmlUrl", "PagerDuty URL", { required: false, editable: false }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
});

/** `GET /business_services`. */
export const BusinessServiceResourceType = rt({
  name: "Business Service",
  id: "pagerduty-business-service",
  description:
    "A capability your customers see (checkout, login), modelled above the technical services it depends on.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("pointOfContact", "Point of Contact", { required: false }),
    f("teamName", "Owning Team", { required: false, editable: false }),
    f("htmlUrl", "PagerDuty URL", { required: false, editable: false }),
  ],
  outputs: [o("businessServiceId", "Business Service ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

/** `GET /event_orchestrations`. */
export const EventOrchestrationResourceType = rt({
  name: "Event Orchestration",
  id: "pagerduty-event-orchestration",
  description:
    "A global ruleset that receives events on its own routing key and routes them to services. Alert routing rules can send here too.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("teamName", "Team", { required: false, editable: false }),
    f("routes", "Routes", { kind: "number", required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("orchestrationId", "Orchestration ID"),
    o("routingKey", "Routing Key", {
      sensitive: true,
      description: "Send Events API v2 events here to have this orchestration route them.",
    }),
  ],
  supportsUpdate: true,
  supportsDelete: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ServiceResourceType,
  EscalationPolicyResourceType,
  ScheduleResourceType,
  TeamResourceType,
  UserResourceType,
  IncidentResourceType,
  MaintenanceWindowResourceType,
  BusinessServiceResourceType,
  EventOrchestrationResourceType,
];
