import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Classic Load Balancer (the 2012-06-01 ELB API). Separate from `alb`
 * because it is a different API, a different CloudWatch namespace
 * (`AWS/ELB`, keyed by `LoadBalancerName`) and a different price; listed so
 * the idle rule and the dashboards can see the balancers nobody migrated.
 */
export const ClassicELBResourceType = rt({
  name: "Classic Load Balancer",
  id: "classic-elb",
  description: "An AWS Classic Load Balancer (previous generation ELB)",
  fields: [
    f("name", "Name"),
    f("scheme", "Scheme", {
      kind: "enum",
      required: false,
      enumValues: ["internet-facing", "internal"],
    }),
    f("vpcId", "VPC ID", { required: false }),
    f("availabilityZones", "Availability Zones", { required: false }),
    f("subnetIds", "Subnets", {
      required: false,
      description: "Comma-separated subnet IDs the load balancer has interfaces in",
    }),
    f("securityGroupIds", "Security Groups", { required: false }),
    f("instanceCount", "Registered Instances", {
      kind: "number",
      required: false,
      description: "EC2 instances registered with the load balancer",
    }),
    f("listeners", "Listeners", {
      required: false,
      description: "Protocol:port to instance protocol:port, comma-separated",
    }),
  ],
  outputs: [o("dnsName", "DNS Name"), o("canonicalHostedZoneId", "Hosted Zone ID")],
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
  iconKey: "load-balancer",
  supportsDelete: true,
  supportsMetrics: true,
});
