import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifyDnsRecordResourceType = rt({
  name: "DNS Record",
  pinnable: false,
  id: "netlify-dns-record",
  description: "A DNS record in a Netlify Managed DNS zone",
  fields: [
    f("name", "Hostname"),
    f("type", "Type"),
    f("content", "Value"),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("managed", "Managed", { kind: "boolean", required: false }),
    f("tag", "Tag", { required: false }),
    f("flag", "Flag", { kind: "number", required: false }),
    f("zoneId", "Zone", { required: false }),
  ],
  outputs: [o("recordId", "Record ID"), o("hostname", "Hostname")],
  dependsOn: [{ fieldKey: "zoneId", targetTypeId: "netlify-dns-zone", label: "in zone" }],
  parentTypeId: "netlify-dns-zone",
  dnsRole: { role: "record", zoneKey: "zoneId", priorityKey: "priority" },
  supportsCreate: true,
  iconKey: "dns-record",
});
