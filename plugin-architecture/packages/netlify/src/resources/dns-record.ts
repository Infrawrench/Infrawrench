import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NetlifyDnsRecordResourceType: ResourceTypeDefinition = {
  id: "netlify-dns-record",
  displayName: "DNS Record",
  pluralDisplayName: "DNS Records",
  description: "A DNS record in a Netlify Managed DNS zone",
  fields: [
    { key: "name", label: "Hostname", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: true },
    { key: "content", label: "Value", kind: "string", required: true },
    { key: "ttl", label: "TTL", kind: "number", required: false },
    { key: "priority", label: "Priority", kind: "number", required: false },
    { key: "managed", label: "Managed", kind: "boolean", required: false },
    { key: "tag", label: "Tag", kind: "string", required: false },
    { key: "flag", label: "Flag", kind: "number", required: false },
  ],
  outputs: [
    { key: "recordId", label: "Record ID", sensitive: false },
    { key: "hostname", label: "Hostname", sensitive: false },
  ],
  parentTypeId: "netlify-dns-zone",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "dns-record",
};
