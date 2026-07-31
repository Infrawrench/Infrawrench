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
  dependsOn: [{ fieldKey: "instanceId", targetTypeId: "ec2-instance", label: "attached to" }],
  supportsCreate: true,
  // associationId covers both instance and bare-ENI associations, so an empty
  // one means the address is truly idle — exactly what AWS charges extra for.
  orphanRule: {
    conditions: [{ fieldKey: "associationId", when: "empty" }],
    reason: "Elastic IP is not associated with any instance or network interface",
  },
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
