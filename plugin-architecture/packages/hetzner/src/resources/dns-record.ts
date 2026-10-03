import { f, rt } from "@infrawrench/plugin-base";

export const DnsRecordResourceType = rt({
  name: "DNS Record Set",
  pinnable: false,
  id: "dns-record",
  description: "A set of DNS records sharing a name and type (an RRSet) in a Hetzner DNS zone",
  fields: [
    f("name", "Name", { description: "Relative to the zone; @ is the apex", editable: false }),
    f("type", "Type", { editable: false }),
    f("content", "Values", {
      description:
        "The record values, one per line or comma-separated. TXT values keep their double quotes",
    }),
    f("ttl", "TTL", {
      kind: "number",
      required: false,
      description: "Seconds. Leave empty to use the zone's default TTL",
    }),
    f("zoneName", "Zone", { required: false, editable: false }),
    f("zoneId", "Zone ID", { required: false, editable: false }),
    f("changeProtection", "Change Protection", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneId", targetTypeId: "dns-zone", label: "in zone" }],
  parentTypeId: "dns-zone",
  dnsRole: { role: "record", zoneKey: "zoneName" },
  supportsCreate: true,
  // Edit = replace the values (`set_records`) and/or the TTL (`change_ttl`).
  supportsUpdate: true,
  iconKey: "dns-record",
});
