import { f, rt } from "@infrawrench/plugin-base";

export const CloudDnsRecordSetResourceType = rt({
  name: "DNS Record Set",
  pinnable: false,
  id: "cloud-dns-record-set",
  description: "A DNS record set within a Google Cloud DNS zone",
  fields: [
    f("type", "Type"),
    f("name", "Name"),
    f("rrdatas", "Data"),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("zoneName", "Zone", { required: false }),
  ],
  outputs: [],
  parentTypeId: "cloud-dns-zone",
  // `zoneName` is the managed zone's resource name, which is also its external
  // id — the zone's `dnsName` is a different string, and the host tries both.
  dnsRole: { role: "record", contentKey: "rrdatas", zoneKey: "zoneName" },
  iconKey: "dns-record",
  supportsCreate: true,
  supportsUpdate: true,
});
