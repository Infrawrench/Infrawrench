import { f, rt } from "@infrawrench/plugin-base";

export const DnsRecordResourceType = rt({
  name: "DNS Record",
  pinnable: false,
  id: "dns-record",
  description: "A DNS record within a Cloudflare zone",
  fields: [
    f("type", "Type", { showcase: true }),
    f("name", "Name"),
    f("content", "Content"),
    f("ttl", "TTL", { showcase: true, kind: "number" }),
    f("proxied", "Proxied", { kind: "boolean", required: false }),
    f("priority", "Priority", { showcase: true, kind: "number", required: false }),
    f("zoneName", "Zone", { required: false, editable: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneName", targetTypeId: "zone", targetKey: "name", label: "in zone" }],
  parentTypeId: "zone",
  dnsRole: {
    role: "record",
    zoneKey: "zoneName",
    priorityKey: "priority",
    proxiedKey: "proxied",
  },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "dns-record",
});
