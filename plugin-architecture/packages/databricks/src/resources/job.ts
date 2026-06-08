import { f, o, rt } from "@infrawrench/plugin-base";

export const JobResourceType = rt({
  name: "Job",
  id: "databricks-job",
  description: "A Databricks workflow/job definition",
  fields: [
    f("jobId", "Job ID", { kind: "number" }),
    f("name", "Name"),
    f("creatorUserName", "Creator", { required: false }),
    f("format", "Format", { required: false }),
    f("lastRunState", "Last Run State", { required: false }),
    f("lastRunResult", "Last Run Result", { required: false }),
    f("schedule", "Schedule", { required: false }),
    f("taskCount", "Tasks", { kind: "number", required: false }),
    f("maxConcurrentRuns", "Max Concurrent Runs", { kind: "number", required: false }),
  ],
  outputs: [o("jobId", "Job ID"), o("jobUrl", "Job URL")],
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
  supportsCreate: true,
  iconKey: "workflow",
});
