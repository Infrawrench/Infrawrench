import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DnsRecordResourceType: ResourceTypeDefinition = {
  id: "dns-record",
  displayName: "DNS Record",
  pluralDisplayName: "DNS Records",
  description: "A DNS record within a Scaleway DNS zone",
  fields: [
    { key: "type", label: "Type", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "data", label: "Data", kind: "string", required: true },
    { key: "ttl", label: "TTL", kind: "number", required: false },
    { key: "priority", label: "Priority", kind: "number", required: false },
    { key: "zoneName", label: "Zone", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "dns-zone",
  dashboardPinnable: false,
  iconKey: "dns-record",
};
