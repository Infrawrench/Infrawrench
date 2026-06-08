import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ElasticIPResourceType: ResourceTypeDefinition = {
  id: "elastic-ip",
  displayName: "Elastic IP",
  pluralDisplayName: "Elastic IPs",
  description: "An AWS Elastic IP address",
  fields: [
    { key: "allocationId", label: "Allocation ID", kind: "string", required: true },
    { key: "publicIp", label: "Public IP", kind: "string", required: true },
    { key: "associationId", label: "Association ID", kind: "string", required: false },
    { key: "instanceId", label: "Instance ID", kind: "string", required: false },
    { key: "networkInterfaceId", label: "Network Interface", kind: "string", required: false },
    { key: "domain", label: "Domain", kind: "string", required: false },
  ],
  outputs: [{ key: "publicIp", label: "Public IP", sensitive: false }],
  dashboardPinnable: false,
  supportsCreate: true,
  attachTargets: [
    {
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      verb: "attach",
    },
    {
      pluginId: "aws",
      resourceTypeId: "subnet",
      verb: "Create NAT gateway",
    },
  ],
  iconKey: "network",
};
