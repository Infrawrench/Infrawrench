import { f, rt } from "@infrawrench/plugin-base";

export const DnsRecordResourceType = rt({
  name: "DNS Record",
  pinnable: false,
  id: "dns-record",
  description: "A DNS record within a Cloudflare zone",
  fields: [
    f("type", "Type"),
    f("name", "Name"),
    f("content", "Content"),
    f("ttl", "TTL", { kind: "number" }),
    f("proxied", "Proxied", { kind: "boolean", required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("zoneName", "Zone", { required: false, editable: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "dns-record",
});
