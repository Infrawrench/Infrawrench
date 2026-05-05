import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const EventBridgeRuleResourceType: ResourceTypeDefinition = {
  id: "eventbridge-rule",
  displayName: "EventBridge Rule",
  pluralDisplayName: "EventBridge Rules",
  description: "An Amazon EventBridge event rule",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["ENABLED", "DISABLED"],
    },
    { key: "eventBusName", label: "Event Bus", kind: "string", required: false },
    { key: "scheduleExpression", label: "Schedule", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
  ],
  outputs: [{ key: "ruleArn", label: "Rule ARN", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "event",
  supportsCreate: true,
};
