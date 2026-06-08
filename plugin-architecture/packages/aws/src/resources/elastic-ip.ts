import { f, o, rt } from "@infrawrench/plugin-base";

export const ElasticIPResourceType = rt({
  name: "Elastic IP",
  pinnable: false,
  id: "elastic-ip",
  description: "An AWS Elastic IP address",
  fields: [
    f("allocationId", "Allocation ID"),
    f("publicIp", "Public IP"),
    f("associationId", "Association ID", { required: false }),
    f("instanceId", "Instance ID", { required: false }),
    f("networkInterfaceId", "Network Interface", { required: false }),
    f("domain", "Domain", { required: false }),
  ],
  outputs: [o("publicIp", "Public IP")],
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
});
