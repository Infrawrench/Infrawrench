import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Devin resource types, one set per organization the key works in. Field
 * names follow the v3 API's response models (https://docs.devin.ai/v3-openapi.json,
 * checked 2026-10). Every type but the organization is addressed
 * `<org_id>/<id>`, since every Devin call takes the org.
 */

const orgFields = [
  f("orgName", "Organization", { required: false, editable: false }),
  f("orgId", "Organization ID", { required: false, editable: false }),
];

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "A Devin organization. Shows this month's ACU consumption by product with an estimated cost, sessions, pull requests and searches, and the organization's ACU limits, and charts ACUs, sessions, pull requests and daily active users.",
  fields: [
    f("name", "Name", { editable: false }),
    f("orgId", "Organization ID", { required: false, editable: false }),
    f("sessionAcuLimit", "ACU Limit per Session", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("cycleAcuLimit", "ACU Limit per Cycle", { kind: "number", required: false, editable: false }),
    f("monthAcus", "ACUs This Month", { kind: "number", required: false, editable: false }),
    f("monthCost", "Estimated Cost This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("orgId", "Organization ID")],
  supportsMetrics: true,
  iconKey: "project",
});

export const SessionResourceType = rt({
  name: "Session",
  id: "session",
  description:
    "A Devin session: its status, who started it, the playbook and tags it ran with, the ACUs it consumed with an estimated cost, and the pull requests it opened. Terminate a running session, archive or unarchive it, edit its tags, and chart its daily ACUs.",
  fields: [
    f("title", "Title", { required: false, editable: false }),
    f("tags", "Tags", {
      required: false,
      description: "Comma-separated tags. Tags are what cost reports group sessions by.",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("statusDetail", "Status Detail", { required: false, editable: false }),
    f("acus", "ACUs Consumed", { kind: "number", required: false, editable: false }),
    f("estimatedCost", "Estimated Cost (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("user", "Started By", { required: false, editable: false }),
    f("userId", "User ID", { required: false, editable: false }),
    f("serviceUserId", "Service User ID", { required: false, editable: false }),
    f("playbookId", "Playbook ID", { required: false, editable: false }),
    f("playbook", "Playbook", { required: false, editable: false }),
    f("origin", "Origin", { required: false, editable: false }),
    f("category", "Category", { required: false, editable: false }),
    f("mode", "Mode", { required: false, editable: false }),
    f("pullRequests", "Pull Requests", { kind: "number", required: false, editable: false }),
    f("pullRequestsMerged", "Merged Pull Requests", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("archived", "Archived", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("sessionId", "Session ID", { required: false, editable: false }),
    ...orgFields,
  ],
  outputs: [o("sessionId", "Session ID"), o("url", "Session URL")],
  dependsOn: [
    {
      fieldKey: "playbookId",
      matchTemplate: "{orgId}/{playbookId}",
      targetTypeId: "playbook",
      label: "runs",
    },
    {
      fieldKey: "userId",
      matchTemplate: "{orgId}/{userId}",
      targetTypeId: "member",
      label: "started by",
    },
  ],
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "job",
});

export const PlaybookResourceType = rt({
  name: "Playbook",
  id: "playbook",
  description:
    "A reusable Devin playbook: the instructions a session follows, the macro that invokes it and the structured output it produces. Create, edit or delete one, see how many sessions ran it and how many of their pull requests merged, and chart both.",
  fields: [
    f("title", "Title"),
    f("macro", "Macro", {
      required: false,
      description: "Typed in a prompt to invoke the playbook. Starts with ! (for example !deploy).",
    }),
    f("body", "Instructions", {
      description: "What Devin should do when it runs this playbook, in Markdown.",
    }),
    f("structuredOutputSchema", "Structured Output Schema", {
      required: false,
      description:
        "Optional JSON Schema (Draft 7) for the structured output sessions running this playbook produce.",
    }),
    f("accessType", "Scope", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("playbookId", "Playbook ID", { required: false, editable: false }),
    ...orgFields,
  ],
  outputs: [o("playbookId", "Playbook ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "file",
});

export const KnowledgeNoteResourceType = rt({
  name: "Knowledge Note",
  id: "knowledge-note",
  description:
    "A piece of Devin knowledge: context Devin recalls when its trigger matches what it is working on. Create, edit, enable, disable or delete a note.",
  fields: [
    f("name", "Name"),
    f("trigger", "Trigger", {
      description: "When Devin should recall this note, in plain language.",
    }),
    f("body", "Content"),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("pinnedRepo", "Pinned Repository", {
      required: false,
      description: "Only recall this note in one repository (owner/repo). Leave blank for all.",
    }),
    f("folder", "Folder", { required: false, editable: false }),
    f("accessType", "Scope", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("noteId", "Note ID", { required: false, editable: false }),
    ...orgFields,
  ],
  outputs: [o("noteId", "Note ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const SecretResourceType = rt({
  name: "Secret",
  id: "secret",
  description:
    "A secret Devin can use in sessions: an API key, site cookie or TOTP seed. Only names and metadata are shown; values are write-only. Add or delete organization secrets.",
  fields: [
    f("key", "Name", { editable: false }),
    f("secretType", "Type", { required: false, editable: false }),
    f("note", "Note", { required: false, editable: false }),
    f("sensitive", "Sensitive", { kind: "boolean", required: false, editable: false }),
    f("accessType", "Scope", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("secretId", "Secret ID", { required: false, editable: false }),
    ...orgFields,
  ],
  outputs: [o("secretId", "Secret ID")],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "secret",
});

export const MemberResourceType = rt({
  name: "Member",
  id: "member",
  description:
    "A member of the Devin organization and their roles. Shows the ACUs they consumed over the last 30 days with an estimated cost, and charts their daily ACUs.",
  fields: [
    f("name", "Name", { required: false, editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("roles", "Roles", { required: false, editable: false }),
    f("acus30d", "ACUs (30 Days)", { kind: "number", required: false, editable: false }),
    f("cost30d", "Estimated Cost (30 Days, USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("userId", "User ID", { required: false, editable: false }),
    ...orgFields,
  ],
  outputs: [o("userId", "User ID"), o("email", "Email")],
  supportsMetrics: true,
  iconKey: "user",
});

export const AutomationResourceType = rt({
  name: "Automation",
  id: "automation",
  description:
    "A Devin automation: sessions or steps that run on a schedule or an event. Shows its triggers, last run and next run. Enable, disable or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("triggers", "Triggers", { required: false, editable: false }),
    f("lastRunAt", "Last Run", { required: false, editable: false }),
    f("lastRunStatus", "Last Run Status", { required: false, editable: false }),
    f("nextRunAt", "Next Run", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("automationId", "Automation ID", { required: false, editable: false }),
    ...orgFields,
  ],
  outputs: [o("automationId", "Automation ID")],
  supportsDelete: true,
  iconKey: "pipeline",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  SessionResourceType,
  PlaybookResourceType,
  KnowledgeNoteResourceType,
  SecretResourceType,
  MemberResourceType,
  AutomationResourceType,
];
