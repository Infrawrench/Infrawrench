import { f, rt } from "@infrawrench/plugin-base";

export const CloudNatResourceType = rt({
  name: "Cloud NAT",
  pinnable: false,
  id: "cloud-nat",
  description: "A Google Cloud NAT gateway configuration",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("router", "Router"),
    f("natIpAllocateOption", "IP Allocation", { required: false }),
    f("sourceSubnetworkIpRangesToNat", "Subnet IP Ranges", { required: false }),
    f("status", "Status", { required: false }),
  ],
  outputs: [],
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
