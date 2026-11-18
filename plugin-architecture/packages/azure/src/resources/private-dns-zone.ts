import { f, o, rt } from "@infrawrench/plugin-base";

export const PrivateDNSZoneResourceType = rt({
  name: "Private DNS Zone",
  id: "azure-private-dns-zone",
  description: "An Azure Private DNS Zone",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    // The max* counts are read-only PrivateZoneProperties reported per zone
    // (Microsoft.Network/privateDnsZones 2020-06-01, azure-rest-api-specs
    // specification/privatedns/.../stable/2020-06-01/privatedns.json).
    f("numberOfRecordSets", "Record Sets", {
      kind: "number",
      required: false,
      usage: { limit: { field: "maxNumberOfRecordSets" }, unit: "record sets" },
    }),
    f("maxNumberOfRecordSets", "Max Record Sets", { kind: "number", required: false }),
    f("virtualNetworkLinkCount", "Virtual Network Links", {
      showcase: true,
      kind: "number",
      required: false,
      usage: { limit: { field: "maxVirtualNetworkLinks" }, unit: "links" },
    }),
    f("maxVirtualNetworkLinks", "Max Virtual Network Links", {
      kind: "number",
      required: false,
      editable: false,
    }),
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
