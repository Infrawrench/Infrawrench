import { f, o, rt } from "@infrawrench/plugin-base";
import { DNS_RECORD_TYPES } from "../catalog.js";

export const VercelDnsRecordResourceType = rt({
  name: "DNS Record",
  pinnable: false,
  id: "vercel-dns-record",
  description: "A DNS record on a domain that uses Vercel's nameservers",
  parentTypeId: "vercel-domain",
  fields: [
    f("name", "Name", { description: "Subdomain, or empty for the apex" }),
    f("type", "Type", { kind: "enum", enumValues: DNS_RECORD_TYPES, editable: false }),
    f("content", "Value"),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("priority", "MX Priority", { kind: "number", required: false }),
    f("comment", "Comment", { required: false }),
    f("domain", "Domain", { editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [o("recordId", "Record ID"), o("fqdn", "Hostname")],
  dependsOn: [
    { fieldKey: "domain", targetTypeId: "vercel-domain", targetKey: "name", label: "in zone" },
  ],
  dnsRole: { role: "record", zoneKey: "domain", priorityKey: "priority" },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "dns-record",
});
