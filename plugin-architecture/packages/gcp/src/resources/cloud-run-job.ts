import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudRunJobResourceType = rt({
  name: "Cloud Run Job",
  id: "cloud-run-job",
  description:
    "A Google Cloud Run job: containers that run to completion, on demand or on a schedule",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { editable: false }),
    f("image", "Container Image", {
      description: "Container image every task runs, e.g. us-docker.pkg.dev/project/repo/image:tag",
    }),
    f("taskCount", "Tasks", {
      kind: "number",
      required: false,
      description: "Number of tasks each execution runs",
    }),
    f("parallelism", "Parallelism", {
      kind: "number",
      required: false,
      description: "Maximum tasks running at once; 0 runs as many as possible",
    }),
    f("maxRetries", "Max Retries", {
      kind: "number",
      required: false,
      description: "Retries allowed per failed task",
    }),
    f("timeoutSeconds", "Task Timeout (s)", {
      kind: "number",
      required: false,
      description: "Maximum run time of a single task attempt, in seconds",
    }),
    f("serviceAccount", "Service Account", {
      required: false,
      editable: false,
      description: "Email of the service account the tasks run as",
    }),
    f("state", "State", { required: false, editable: false }),
    f("executionCount", "Executions", { kind: "number", required: false, editable: false }),
    f("lastExecution", "Last Execution", { required: false, editable: false }),
    f("lastExecutionStatus", "Last Execution Status", { required: false, editable: false }),
    f("lastExecutionTime", "Last Execution Time", { required: false, editable: false }),
  ],
  outputs: [o("jobName", "Job Name")],
  dependsOn: [
    { fieldKey: "serviceAccount", targetTypeId: "gcp-service-account", label: "runs as" },
  ],
  supportsCreate: true,
  // Edit = image, task count, parallelism, retries and timeout; jobs.patch
  // replaces the whole job, so the handler reads it first and changes only these.
  supportsUpdate: true,
  supportsMetrics: true,
});
