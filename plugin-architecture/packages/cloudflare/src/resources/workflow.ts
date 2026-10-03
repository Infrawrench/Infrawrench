import { f, o, rt } from "@infrawrench/plugin-base";

export const WorkflowResourceType = rt({
  name: "Workflow",
  id: "workflow",
  description: "A Cloudflare Workflow: a durable, multi-step execution declared by a Worker",
  fields: [
    f("name", "Name"),
    f("className", "Class", { required: false }),
    f("scriptName", "Worker Script", { required: false }),
    f("running", "Running", { kind: "number", required: false }),
    f("queued", "Queued", { kind: "number", required: false }),
    f("waiting", "Waiting", { kind: "number", required: false }),
    f("paused", "Paused", { kind: "number", required: false }),
    f("errored", "Errored", { kind: "number", required: false }),
    f("complete", "Complete", { kind: "number", required: false }),
    f("terminated", "Terminated", { kind: "number", required: false }),
    f("schedules", "Cron Schedules", { required: false }),
    f("nextScheduledRun", "Next Scheduled Run", { required: false }),
    f("lastTriggered", "Last Triggered", { required: false }),
    f("workflowId", "Workflow ID", { required: false }),
  ],
  outputs: [o("workflowName", "Workflow Name")],
  supportsMetrics: true,
  iconKey: "function",
  secretExportTemplates: [
    {
      id: "workflow-binding",
      displayName: "Workflow Binding",
      description: "Workflow name for a wrangler `[[workflows]]` binding",
      entries: [{ envKey: "WORKFLOW_NAME", outputKey: "workflowName" }],
    },
  ],
});
