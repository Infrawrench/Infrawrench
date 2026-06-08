import { f, o, rt } from "@infrawrench/plugin-base";

export const StepFunctionResourceType = rt({
  name: "Step Function",
  id: "step-function",
  description: "An AWS Step Functions state machine",
  fields: [
    f("name", "Name"),
    f("status", "Status", { kind: "enum", enumValues: ["ACTIVE", "DELETING"] }),
    f("type", "Type", { kind: "enum", enumValues: ["STANDARD", "EXPRESS"] }),
    f("creationDate", "Created", { required: false }),
  ],
  outputs: [o("stateMachineArn", "State Machine ARN")],
  iconKey: "workflow",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "step-function-arn",
      displayName: "State Machine ARN",
      description: "State machine ARN for SDK invocation",
      entries: [{ envKey: "STATE_MACHINE_ARN", outputKey: "stateMachineArn" }],
    },
  ],
});
