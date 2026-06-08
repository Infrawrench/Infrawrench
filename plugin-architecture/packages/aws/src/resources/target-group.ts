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
  ],
  outputs: [o("targetGroupArn", "Target Group ARN")],
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
