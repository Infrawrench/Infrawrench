import { f, o, rt } from "@infrawrench/plugin-base";

export const DNSZoneResourceType = rt({
  name: "DNS Zone",
  id: "azure-dns-zone",
  description: "An Azure DNS Zone",
  equivalence: "dns-zone",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    f("zoneType", "Zone Type"),
    // maxNumberOfRecordSets is read-only and reported by ARM per zone:
    // https://learn.microsoft.com/rest/api/dns/zones/list?view=rest-dns-2018-05-01
    f("numberOfRecordSets", "Record Sets", {
      kind: "number",
      required: false,
      usage: { limit: { field: "maxNumberOfRecordSets" }, unit: "record sets" },
    }),
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
