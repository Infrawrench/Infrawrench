import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const StepFunctionResourceType: ResourceTypeDefinition = {
  id: "step-function",
  displayName: "Step Function",
  pluralDisplayName: "Step Functions",
  description: "An AWS Step Functions state machine",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
      enumValues: ["ACTIVE", "DELETING"],
    },
    {
      key: "type",
      label: "Type",
      kind: "enum",
      required: true,
      enumValues: ["STANDARD", "EXPRESS"],
    },
    { key: "creationDate", label: "Created", kind: "string", required: false },
  ],
  outputs: [{ key: "stateMachineArn", label: "State Machine ARN", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "workflow",
};
