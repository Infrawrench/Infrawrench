import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DnsRecordResourceType: ResourceTypeDefinition = {
  id: "dns-record",
  displayName: "DNS Record",
  pluralDisplayName: "DNS Records",
  description: "A DNS record within a Cloudflare zone",
  fields: [
    { key: "type", label: "Type", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "content", label: "Content", kind: "string", required: true },
    { key: "ttl", label: "TTL", kind: "number", required: true },
    { key: "proxied", label: "Proxied", kind: "boolean", required: false },
    { key: "priority", label: "Priority", kind: "number", required: false },
    { key: "zoneName", label: "Zone", kind: "string", required: false },
    { key: "comment", label: "Comment", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "dns-record",
};
