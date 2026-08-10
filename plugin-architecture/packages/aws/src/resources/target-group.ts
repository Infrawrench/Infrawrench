import { f, o, rt } from "@infrawrench/plugin-base";

export const TargetGroupResourceType = rt({
  name: "Target Group",
  id: "target-group",
  description: "An AWS ELB target group",
  parentTypeId: "alb",
  fields: [
    f("name", "Name"),
    f("protocol", "Protocol"),
    f("port", "Port", { kind: "number" }),
    f("targetType", "Target Type", {
      kind: "enum",
      enumValues: ["instance", "ip", "lambda", "alb"],
    }),
    f("vpcId", "VPC ID", { required: false }),
    f("healthCheckProtocol", "Health Check Protocol", { required: false }),
    f("healthCheckPath", "Health Check Path", { required: false }),
    f("healthyThreshold", "Healthy Threshold", { kind: "number", required: false }),
    f("loadBalancerArns", "Load Balancers", {
      required: false,
      description: "Comma-separated ARNs of the load balancers this group is attached to",
    }),
  ],
  outputs: [o("targetGroupArn", "Target Group ARN")],
  // Attached load balancers are named by ARN; an ALB's external id is its name,
  // so match its `loadBalancerArn` output.
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    {
      fieldKey: "loadBalancerArns",
      targetTypeId: "alb",
      targetKey: "loadBalancerArn",
      label: "attached to",
    },
  ],
  iconKey: "load-balancer",
  supportsCreate: true,
  supportsMetrics: true,
  attachTargets: [
    {
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      matchField: "vpcId",
      verb: "Register target",
    },
  ],
});
