import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const BatchJobQueueResourceType: ResourceTypeDefinition = {
  id: "batch-job-queue",
  displayName: "Batch Job Queue",
  pluralDisplayName: "Batch Job Queues",
  description: "An AWS Batch job queue",
  fields: [
    { key: "jobQueueName", label: "Queue Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["ENABLED", "DISABLED"],
    },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: false,
      enumValues: ["CREATING", "UPDATING", "DELETING", "DELETED", "VALID", "INVALID"],
    },
    { key: "priority", label: "Priority", kind: "number", required: false },
    { key: "schedulingPolicyArn", label: "Scheduling Policy", kind: "string", required: false },
  ],
  outputs: [
    { key: "jobQueueArn", label: "Job Queue ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "queue",
};
