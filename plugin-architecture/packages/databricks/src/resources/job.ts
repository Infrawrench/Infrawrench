import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const JobResourceType: ResourceTypeDefinition = {
  id: "databricks-job",
  displayName: "Job",
  pluralDisplayName: "Jobs",
  description: "A Databricks workflow/job definition",
  fields: [
    { key: "jobId", label: "Job ID", kind: "number", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "creatorUserName", label: "Creator", kind: "string", required: false },
    { key: "format", label: "Format", kind: "string", required: false },
    { key: "lastRunState", label: "Last Run State", kind: "string", required: false },
    { key: "lastRunResult", label: "Last Run Result", kind: "string", required: false },
    { key: "schedule", label: "Schedule", kind: "string", required: false },
    { key: "taskCount", label: "Tasks", kind: "number", required: false },
    { key: "maxConcurrentRuns", label: "Max Concurrent Runs", kind: "number", required: false },
  ],
  outputs: [
    { key: "jobId", label: "Job ID", sensitive: false },
    { key: "jobUrl", label: "Job URL", sensitive: false },
  ],
  attachTargets: [
    {
      pluginId: "databricks",
      resourceTypeId: "databricks-cluster",
      verb: "Use cluster",
    },
    {
      pluginId: "databricks",
      resourceTypeId: "databricks-sql-warehouse",
      verb: "Use warehouse",
    },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "workflow",
};
