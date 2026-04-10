import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TargetGroupResourceType: ResourceTypeDefinition = {
  id: "target-group",
  displayName: "Target Group",
  pluralDisplayName: "Target Groups",
  description: "An AWS ELB target group",
  parentTypeId: "alb",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "protocol", label: "Protocol", kind: "string", required: true },
    { key: "port", label: "Port", kind: "number", required: true },
    { key: "targetType", label: "Target Type", kind: "enum", required: true, enumValues: ["instance", "ip", "lambda", "alb"] },
    { key: "vpcId", label: "VPC ID", kind: "string", required: false },
    { key: "healthCheckProtocol", label: "Health Check Protocol", kind: "string", required: false },
    { key: "healthCheckPath", label: "Health Check Path", kind: "string", required: false },
    { key: "healthyThreshold", label: "Healthy Threshold", kind: "number", required: false },
  ],
  outputs: [
    { key: "targetGroupArn", label: "Target Group ARN", sensitive: false },
  ],
  dashboardPinnable: false,
  iconKey: "load-balancer",
};
