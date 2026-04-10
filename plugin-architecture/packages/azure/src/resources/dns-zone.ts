import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DNSZoneResourceType: ResourceTypeDefinition = {
  id: "azure-dns-zone",
  displayName: "DNS Zone",
  pluralDisplayName: "DNS Zones",
  description: "An Azure DNS Zone",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "zoneType", label: "Zone Type", kind: "string", required: true },
    { key: "numberOfRecordSets", label: "Record Sets", kind: "number", required: false },
    { key: "maxNumberOfRecordSets", label: "Max Record Sets", kind: "number", required: false },
  ],
  outputs: [
    { key: "nameServers", label: "Name Servers", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "dns",
  supportsCreate: true,
};
