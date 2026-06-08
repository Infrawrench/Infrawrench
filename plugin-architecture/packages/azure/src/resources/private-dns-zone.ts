import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PrivateDNSZoneResourceType: ResourceTypeDefinition = {
  id: "azure-private-dns-zone",
  displayName: "Private DNS Zone",
  pluralDisplayName: "Private DNS Zones",
  description: "An Azure Private DNS Zone",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "numberOfRecordSets", label: "Record Sets", kind: "number", required: false },
    { key: "maxNumberOfRecordSets", label: "Max Record Sets", kind: "number", required: false },
    {
      key: "virtualNetworkLinkCount",
      label: "Virtual Network Links",
      kind: "number",
      required: false,
    },
  ],
  outputs: [{ key: "resourceId", label: "Resource ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "dns",
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-vnet",
      verb: "Link VNet",
    },
  ],
};
