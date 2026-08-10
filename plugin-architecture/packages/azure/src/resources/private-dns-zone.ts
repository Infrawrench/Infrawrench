import { f, o, rt } from "@infrawrench/plugin-base";

export const PrivateDNSZoneResourceType = rt({
  name: "Private DNS Zone",
  id: "azure-private-dns-zone",
  description: "An Azure Private DNS Zone",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("numberOfRecordSets", "Record Sets", { kind: "number", required: false }),
    f("maxNumberOfRecordSets", "Max Record Sets", { kind: "number", required: false }),
    f("virtualNetworkLinkCount", "Virtual Network Links", { kind: "number", required: false }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  supportsMetrics: true,
  iconKey: "dns",
  dnsRole: {
    role: "zone",
    domainKey: "name",
    recordCountKey: "numberOfRecordSets",
    isPrivate: true,
  },
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-vnet",
      verb: "Link VNet",
    },
  ],
});
