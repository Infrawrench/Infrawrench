import { f, rt } from "@infrawrench/plugin-base";

export const DnsRecordResourceType = rt({
  name: "DNS Record",
  pinnable: false,
  id: "dns-record",
  description: "A DNS record within a DigitalOcean domain",
  fields: [
    f("type", "Type"),
    f("name", "Name"),
    f("data", "Data"),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("port", "Port", { kind: "number", required: false }),
    f("weight", "Weight", { kind: "number", required: false }),
    f("flags", "Flags", { kind: "number", required: false }),
    f("tag", "Tag", { required: false }),
    f("domainName", "Domain", { required: false }),
  ],
  outputs: [],
  // The domain's externalId is its name, which is what the lister stores here.
  dependsOn: [{ fieldKey: "domainName", targetTypeId: "domain", label: "in domain" }],
  parentTypeId: "domain",
  // DigitalOcean stores record names relative to the domain (`@` for the
  // apex); the host qualifies them against the zone.
  dnsRole: { role: "record", contentKey: "data", zoneKey: "domainName", priorityKey: "priority" },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "dns-record",
});
