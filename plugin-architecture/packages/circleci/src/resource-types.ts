import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * CircleCI resource types. Everything is scoped to the organization picked in
 * the credentials. Field names follow the v2 API reference
 * (https://circleci.com/docs/api/v2/, 2026-10).
 */

const projectRef = f("projectSlug", "Project", { required: false, editable: false });

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "The CircleCI organization this connection reads. Shows credits used, runs, success rate and estimated cost over the last 30 days, per project, and charts credits used per day.",
  fields: [
    f("name", "Name", { editable: false }),
    f("slug", "Slug", { required: false, editable: false }),
    f("vcsType", "VCS", { required: false, editable: false }),
    f("credits30d", "Credits Used (30 days)", { kind: "number", required: false, editable: false }),
    f("estimatedCost30d", "Estimated Cost (30 days, USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("runs30d", "Workflow Runs (30 days)", { kind: "number", required: false, editable: false }),
    f("successRate30d", "Success Rate (30 days, %)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("projectCount", "Projects", { kind: "number", required: false, editable: false }),
    f("orgId", "Organization ID", { required: false, editable: false }),
  ],
  outputs: [
    o("slug", "Organization slug"),
    o("orgId", "Organization ID"),
    o("url", "CircleCI URL"),
  ],
  supportsMetrics: true,
  iconKey: "account",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A CircleCI project. Shows its repository, credits used, estimated cost, runs and success rate over the last 30 days, its workflows, and its flaky tests, and charts credits, runs and failures per day.",
  fields: [
    f("name", "Name", { editable: false }),
    f("slug", "Slug", { required: false, editable: false }),
    f("vcsUrl", "Repository", { required: false, editable: false }),
    f("vcsProvider", "VCS Provider", { required: false, editable: false }),
    f("defaultBranch", "Default Branch", { required: false, editable: false }),
    f("credits30d", "Credits Used (30 days)", { kind: "number", required: false, editable: false }),
    f("estimatedCost30d", "Estimated Cost (30 days, USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("runs30d", "Workflow Runs (30 days)", { kind: "number", required: false, editable: false }),
    f("successRate30d", "Success Rate (30 days, %)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("durationSecs30d", "Total Duration (30 days, seconds)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("projectId", "Project ID", { required: false, editable: false }),
  ],
  outputs: [o("slug", "Project slug"), o("projectId", "Project ID"), o("url", "CircleCI URL")],
  supportsMetrics: true,
  iconKey: "app",
});

export const WorkflowResourceType = rt({
  name: "Workflow",
  id: "workflow",
  parentTypeId: "project",
  description:
    "A workflow in a project's config, with 30-day metrics across all branches: runs, success rate, duration percentiles, credits, time to recover and throughput. Lists its jobs and recent runs (with Rerun and Rerun from failed) and charts duration, success rate and credits.",
  fields: [
    f("name", "Name", { editable: false }),
    projectRef,
    f("totalRuns", "Runs (30 days)", { kind: "number", required: false, editable: false }),
    f("successRate", "Success Rate (%)", { kind: "number", required: false, editable: false }),
    f("failedRuns", "Failed Runs", { kind: "number", required: false, editable: false }),
    f("durationMedianSecs", "Duration p50 (seconds)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("durationP95Secs", "Duration p95 (seconds)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("credits", "Credits Used (30 days)", { kind: "number", required: false, editable: false }),
    f("mttrSecs", "Mean Time to Recovery (seconds)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("throughput", "Runs per Day", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("name", "Workflow name")],
  supportsMetrics: true,
  iconKey: "workflow",
});

export const PipelineResourceType = rt({
  name: "Pipeline",
  id: "pipeline",
  description:
    "A recent pipeline run: project, branch, commit, trigger and the status of each workflow, with Rerun, Rerun from failed and Cancel. The 50 most recent are listed. Create one to trigger a pipeline on a project and branch.",
  fields: [
    f("number", "Number", { kind: "number", required: false, editable: false }),
    projectRef,
    f("state", "State", { required: false, editable: false }),
    f("branch", "Branch", { required: false, editable: false }),
    f("tag", "Tag", { required: false, editable: false }),
    f("revision", "Revision", { required: false, editable: false }),
    f("commitSubject", "Commit", { required: false, editable: false }),
    f("trigger", "Trigger", { required: false, editable: false }),
    f("actor", "Triggered By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("errors", "Errors", { required: false, editable: false }),
  ],
  outputs: [o("pipelineId", "Pipeline ID"), o("url", "CircleCI URL")],
  supportsCreate: true,
  iconKey: "play",
  pinnable: false,
});

export const ContextResourceType = rt({
  name: "Context",
  id: "context",
  description:
    "A context: a named set of environment variables shared across projects. Only variable names are shown; CircleCI never returns values. Create or delete a context, and add, change or remove its variables.",
  fields: [
    f("name", "Name", { editable: false }),
    f("variableCount", "Variables", { kind: "number", required: false, editable: false }),
    f("variables", "Variable Names", { required: false, editable: false }),
    f("restrictions", "Restrictions", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("contextId", "Context ID", { required: false, editable: false }),
  ],
  outputs: [o("contextId", "Context ID"), o("name", "Context name")],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const ContextVariableResourceType = rt({
  name: "Context Variable",
  id: "context-variable",
  parentTypeId: "context",
  description:
    "An environment variable in a context. The value is write-only: set it when creating the variable, or type a new one under Edit to replace it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "Write-only. Leave empty to keep the current value.",
    }),
    f("context", "Context", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("name", "Variable name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
  pinnable: false,
});

export const ProjectVariableResourceType = rt({
  name: "Project Variable",
  id: "project-variable",
  parentTypeId: "project",
  description:
    "An environment variable set on a project. CircleCI only returns a masked value (the last four characters). Create one, replace its value under Edit, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "Write-only. Leave empty to keep the current value.",
    }),
    f("maskedValue", "Masked Value", { required: false, editable: false }),
    projectRef,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("name", "Variable name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
  pinnable: false,
});

export const ScheduleResourceType = rt({
  name: "Schedule",
  id: "schedule",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "A scheduled pipeline on a GitHub OAuth or Bitbucket project: when it runs (times per hour, hours of the day in UTC, days of the week or month, months) and with which branch and parameters. Create, edit or delete a schedule.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("perHour", "Runs per Hour", {
      kind: "number",
      required: false,
      description: "How many times it runs in each chosen hour, from 1 to 60.",
    }),
    f("hoursOfDay", "Hours of Day (UTC)", {
      required: false,
      description: "Comma-separated hours from 0 to 23, e.g. 0,6,12,18.",
    }),
    f("daysOfWeek", "Days of Week", {
      required: false,
      description:
        "Comma-separated three-letter days, e.g. MON,TUE,WED,THU,FRI. Leave empty when using days of month.",
    }),
    f("daysOfMonth", "Days of Month", {
      required: false,
      description: "Comma-separated days from 1 to 31. Leave empty when using days of week.",
    }),
    f("months", "Months", {
      required: false,
      description:
        "Comma-separated three-letter months, e.g. JAN,APR,JUL,OCT. Empty means every month.",
    }),
    f("branch", "Branch", { required: false }),
    f("parameters", "Pipeline Parameters (JSON)", {
      required: false,
      description: 'Extra pipeline parameters as a JSON object, e.g. {"deploy": true}.',
    }),
    f("timetable", "Runs", { required: false, editable: false }),
    f("actor", "Runs As", { required: false, editable: false }),
    projectRef,
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("scheduleId", "Schedule ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "clock",
});

export const TriggerResourceType = rt({
  name: "Trigger",
  id: "trigger",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "A trigger on a project's pipeline definition (GitHub App and CircleCI projects): a repository event preset, webhook or cron schedule, with the refs it checks out. Enable, disable, edit, delete or create one.",
  fields: [
    f("name", "Name", { required: false, editable: false }),
    f("source", "Source", { required: false, editable: false }),
    f("eventPreset", "Event", { required: false, editable: false }),
    f("cronExpression", "Cron Schedule (UTC)", {
      required: false,
      description: "Only for scheduled triggers: five-field cron, e.g. 0 3 * * 1-5.",
    }),
    f("checkoutRef", "Checkout Ref", { required: false }),
    f("configRef", "Config Ref", { required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false, editable: false }),
    f("pipelineDefinition", "Pipeline Definition", { required: false, editable: false }),
    f("repository", "Repository", { required: false, editable: false }),
    projectRef,
  ],
  outputs: [o("triggerId", "Trigger ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "clock",
});

export const RunnerResourceClassResourceType = rt({
  name: "Runner Resource Class",
  plural: "Runner Resource Classes",
  id: "runner-resource-class",
  description:
    "A self-hosted runner resource class: the label jobs target to run on your machines. Shows its runners and waiting or running tasks. Create, edit or delete it, or mint a runner token with Get credentials.",
  fields: [
    f("name", "Resource Class", { editable: false }),
    f("description", "Description", { required: false }),
    f("runnerCount", "Runners", { kind: "number", required: false, editable: false }),
    f("unclaimedTasks", "Tasks Waiting", { kind: "number", required: false, editable: false }),
    f("runningTasks", "Tasks Running", { kind: "number", required: false, editable: false }),
    f("resourceClassId", "ID", { required: false, editable: false }),
  ],
  outputs: [o("name", "Resource class")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  credentialFormats: [
    {
      id: "runner-token",
      label: "Runner token",
      description: "A new token for installing a runner agent on this resource class.",
      mediaType: "text",
      filenameTemplate: "circleci-runner-token.txt",
    },
  ],
  iconKey: "server",
});

export const RunnerResourceType = rt({
  name: "Runner",
  id: "runner",
  parentTypeId: "runner-resource-class",
  showInSidebar: true,
  description:
    "A self-hosted runner agent connected to a resource class: its version, whether it is running a job right now, and when it first and last connected.",
  fields: [
    f("name", "Name", { editable: false }),
    f("resourceClass", "Resource Class", { required: false, editable: false }),
    f("busy", "Running a Job", { kind: "boolean", required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("firstConnected", "First Connected", { required: false, editable: false }),
    f("lastConnected", "Last Connected", { required: false, editable: false }),
  ],
  outputs: [o("name", "Runner name")],
  iconKey: "server",
  pinnable: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  ProjectResourceType,
  WorkflowResourceType,
  PipelineResourceType,
  ContextResourceType,
  ContextVariableResourceType,
  ProjectVariableResourceType,
  ScheduleResourceType,
  TriggerResourceType,
  RunnerResourceClassResourceType,
  RunnerResourceType,
];
