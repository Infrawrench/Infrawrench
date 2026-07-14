import { f, o, rt } from "@infrawrench/plugin-base";

export const EventBridgeRuleResourceType = rt({
  name: "EventBridge Rule",
  id: "eventbridge-rule",
  description: "An Amazon EventBridge event rule",
  fields: [
    f("name", "Name"),
    f("state", "State", { kind: "enum", enumValues: ["ENABLED", "DISABLED"] }),
    f("eventBusName", "Event Bus", { required: false }),
    f("scheduleExpression", "Schedule", { required: false }),
    f("description", "Description", { required: false }),
  ],
  outputs: [o("ruleArn", "Rule ARN")],
  iconKey: "event",
  supportsCreate: true,
  supportsMetrics: true,
});
