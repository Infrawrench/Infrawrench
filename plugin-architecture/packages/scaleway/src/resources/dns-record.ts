import { f, rt } from "@infrawrench/plugin-base";

export const DnsRecordResourceType = rt({
  id: "dns-record",
  name: "DNS Record",
  pinnable: false,
  description: "A record in a Scaleway DNS zone",
  fields: [
    f("name", "Name", { description: "Relative to the zone; @ is the apex" }),
    f("type", "Type", { editable: false }),
    f("content", "Value"),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("comment", "Comment", { required: false, editable: false }),
    f("zoneName", "Zone", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneName", targetTypeId: "dns-zone", label: "in zone" }],
  parentTypeId: "dns-zone",
  dnsRole: { role: "record", zoneKey: "zoneName", priorityKey: "priority" },
  supportsCreate: true,
  // Edit = replace the record (`PATCH /records` with a `set` change).
  supportsUpdate: true,
  iconKey: "dns-record",
});
