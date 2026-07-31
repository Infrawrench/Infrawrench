import { f, o, rt } from "@infrawrench/plugin-base";

export const AutoScalingGroupResourceType = rt({
  name: "Auto Scaling Group",
  id: "auto-scaling-group",
  description: "An AWS EC2 Auto Scaling group",
  fields: [
    f("name", "Name"),
    f("minSize", "Min Size", { kind: "number" }),
    f("maxSize", "Max Size", { kind: "number" }),
    f("desiredCapacity", "Desired Capacity", { kind: "number" }),
    f("status", "Status", { required: false }),
    f("healthCheckType", "Health Check Type", {
      kind: "enum",
      required: false,
      enumValues: ["EC2", "ELB"],
    }),
    f("availabilityZones", "Availability Zones", { required: false }),
    f("launchTemplate", "Launch Template", { required: false }),
    f("instanceCount", "Instance Count", { kind: "number", required: false }),
    f("subnetIds", "Subnets", {
      required: false,
      description: "Comma-separated subnet IDs the group launches into (VPCZoneIdentifier)",
    }),
    f("targetGroupArns", "Target Groups", {
      required: false,
      description: "Comma-separated ARNs of the target groups instances are registered with",
    }),
  ],
  outputs: [o("autoScalingGroupArn", "ASG ARN")],
  // Target groups are attached by ARN; a target group's external id is its
  // name, so match its `targetGroupArn` output instead.
  dependsOn: [
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "launches into" },
    {
      fieldKey: "targetGroupArns",
      targetTypeId: "target-group",
      targetKey: "targetGroupArn",
      label: "registers with",
    },
  ],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "scaling",
  attachTargets: [{ pluginId: "aws", resourceTypeId: "target-group", verb: "Attach target group" }],
});
