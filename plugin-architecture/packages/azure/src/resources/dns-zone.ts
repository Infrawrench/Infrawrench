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
  supportsMetrics: true,
  iconKey: "dns",
  supportsCreate: true,
});
