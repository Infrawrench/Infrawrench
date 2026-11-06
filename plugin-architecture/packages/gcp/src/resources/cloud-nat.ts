import { f, rt } from "@infrawrench/plugin-base";

export const CloudNatResourceType = rt({
  name: "Cloud NAT",
  pinnable: false,
  id: "cloud-nat",
  iconKey: "route",
  description: "A Google Cloud NAT gateway configuration",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true }),
    f("router", "Router"),
    f("natIpAllocateOption", "IP Allocation", { required: false }),
    f("sourceSubnetworkIpRangesToNat", "Subnet IP Ranges", { required: false }),
    f("status", "Status", { showcase: true, required: false }),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "router", targetTypeId: "cloud-router", targetKey: "name", label: "on router" },
  ],
  supportsCreate: true,
  supportsMetrics: true,
  attachTargets: [
    {
      pluginId: "gcp",
      resourceTypeId: "subnet",
      matchField: "region",
      verb: "Apply NAT",
    },
  ],
});
