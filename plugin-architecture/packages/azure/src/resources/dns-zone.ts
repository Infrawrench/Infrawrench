import { f, o, rt } from "@infrawrench/plugin-base";

export const DNSZoneResourceType = rt({
  name: "DNS Zone",
  id: "azure-dns-zone",
  description: "An Azure DNS Zone",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("zoneType", "Zone Type"),
    f("numberOfRecordSets", "Record Sets", { kind: "number", required: false }),
    f("maxNumberOfRecordSets", "Max Record Sets", { kind: "number", required: false }),
  ],
  outputs: [o("nameServers", "Name Servers")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  supportsMetrics: true,
  iconKey: "dns",
  supportsCreate: true,
  dnsRole: {
    role: "zone",
    domainKey: "name",
    recordCountKey: "numberOfRecordSets",
    privateKey: "zoneType",
    privateValues: ["private"],
  },
});
