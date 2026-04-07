import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudDnsRecordSetResourceType: ResourceTypeDefinition = {
  id: "cloud-dns-record-set",
  displayName: "DNS Record Set",
  pluralDisplayName: "DNS Record Sets",
  description: "A DNS record set within a Google Cloud DNS zone",
  fields: [
    { key: "type", label: "Type", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "rrdatas", label: "Data", kind: "string", required: true },
    { key: "ttl", label: "TTL", kind: "number", required: false },
    { key: "zoneName", label: "Zone", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "cloud-dns-zone",
  dashboardPinnable: false,
  iconKey: "dns-record",
};
