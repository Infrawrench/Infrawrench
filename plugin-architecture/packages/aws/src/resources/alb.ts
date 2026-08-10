import { f, o, rt } from "@infrawrench/plugin-base";

export const ALBResourceType = rt({
  name: "Load Balancer",
  id: "alb",
  description: "An AWS Elastic Load Balancer (ALB/NLB/GLB)",
  fields: [
    f("name", "Name"),
    f("type", "Type", { kind: "enum", enumValues: ["application", "network", "gateway"] }),
    f("state", "State", {
      kind: "enum",
      enumValues: ["active", "provisioning", "active_impaired", "failed"],
    }),
    f("scheme", "Scheme", {
      kind: "enum",
      required: false,
      enumValues: ["internet-facing", "internal"],
    }),
    f("vpcId", "VPC ID", { required: false }),
    f("availabilityZones", "Availability Zones", { required: false }),
    f("ipAddressType", "IP Address Type", { required: false }),
    f("subnetIds", "Subnets", {
      required: false,
      description: "Comma-separated subnet IDs the load balancer has interfaces in",
    }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated security group IDs (application load balancers only)",
    }),
  ],
  outputs: [
    o("dnsName", "DNS Name"),
    o("loadBalancerArn", "Load Balancer ARN"),
    o("canonicalHostedZoneId", "Hosted Zone ID"),
  ],
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
  iconKey: "load-balancer",
  supportsCreate: true,
  supportsMetrics: true,
});
