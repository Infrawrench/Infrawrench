import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AutoScalingGroupResourceType: ResourceTypeDefinition = {
  id: "auto-scaling-group",
  displayName: "Auto Scaling Group",
  pluralDisplayName: "Auto Scaling Groups",
  description: "An AWS EC2 Auto Scaling group",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "minSize", label: "Min Size", kind: "number", required: true },
    { key: "maxSize", label: "Max Size", kind: "number", required: true },
    { key: "desiredCapacity", label: "Desired Capacity", kind: "number", required: true },
    { key: "status", label: "Status", kind: "string", required: false },
    {
      key: "healthCheckType",
      label: "Health Check Type",
      kind: "enum",
      required: false,
      enumValues: ["EC2", "ELB"],
    },
    { key: "availabilityZones", label: "Availability Zones", kind: "string", required: false },
    { key: "launchTemplate", label: "Launch Template", kind: "string", required: false },
    { key: "instanceCount", label: "Instance Count", kind: "number", required: false },
  ],
  outputs: [{ key: "autoScalingGroupArn", label: "ASG ARN", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "scaling",
};
