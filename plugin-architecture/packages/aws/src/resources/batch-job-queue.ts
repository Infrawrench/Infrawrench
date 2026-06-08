import { f, o, rt } from "@infrawrench/plugin-base";

export const BatchJobQueueResourceType = rt({
  name: "Batch Job Queue",
  id: "batch-job-queue",
  description: "An AWS Batch job queue",
  fields: [
    f("jobQueueName", "Queue Name"),
    f("state", "State", { kind: "enum", enumValues: ["ENABLED", "DISABLED"] }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: ["CREATING", "UPDATING", "DELETING", "DELETED", "VALID", "INVALID"],
    }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("schedulingPolicyArn", "Scheduling Policy", { required: false }),
  ],
  outputs: [o("jobQueueArn", "Job Queue ARN")],
  supportsCreate: true,
  iconKey: "queue",
});
