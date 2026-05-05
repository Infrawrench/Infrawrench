import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudNatResourceType: ResourceTypeDefinition = {
  id: "cloud-nat",
  displayName: "Cloud NAT",
  pluralDisplayName: "Cloud NATs",
  description: "A Google Cloud NAT gateway configuration",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "router", label: "Router", kind: "string", required: true },
    { key: "natIpAllocateOption", label: "IP Allocation", kind: "string", required: false },
    {
      key: "sourceSubnetworkIpRangesToNat",
      label: "Subnet IP Ranges",
      kind: "string",
      required: false,
    },
    { key: "status", label: "Status", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
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
};
