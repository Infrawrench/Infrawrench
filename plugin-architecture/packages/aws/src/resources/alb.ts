import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ALBResourceType: ResourceTypeDefinition = {
  id: "alb",
  displayName: "Load Balancer",
  pluralDisplayName: "Load Balancers",
  description: "An AWS Elastic Load Balancer (ALB/NLB/GLB)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "type",
      label: "Type",
      kind: "enum",
      required: true,
      enumValues: ["application", "network", "gateway"],
    },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["active", "provisioning", "active_impaired", "failed"],
    },
    {
      key: "scheme",
      label: "Scheme",
      kind: "enum",
      required: false,
      enumValues: ["internet-facing", "internal"],
    },
    { key: "vpcId", label: "VPC ID", kind: "string", required: false },
    { key: "availabilityZones", label: "Availability Zones", kind: "string", required: false },
    { key: "ipAddressType", label: "IP Address Type", kind: "string", required: false },
  ],
  outputs: [
    { key: "dnsName", label: "DNS Name", sensitive: false },
    { key: "loadBalancerArn", label: "Load Balancer ARN", sensitive: false },
    { key: "canonicalHostedZoneId", label: "Hosted Zone ID", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "load-balancer",
  supportsCreate: true,
  supportsMetrics: true,
};
