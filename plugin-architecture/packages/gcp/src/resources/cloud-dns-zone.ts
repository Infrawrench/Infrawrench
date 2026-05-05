import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudDnsZoneResourceType: ResourceTypeDefinition = {
  id: "cloud-dns-zone",
  displayName: "Cloud DNS Zone",
  pluralDisplayName: "Cloud DNS Zones",
  description: "A Google Cloud DNS managed zone",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "dnsName", label: "DNS Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "visibility", label: "Visibility", kind: "string", required: false },
    { key: "nameservers", label: "Nameservers", kind: "string", required: false },
    { key: "dnssecState", label: "DNSSEC", kind: "string", required: false },
    { key: "recordCount", label: "Record Count", kind: "number", required: false },
  ],
  outputs: [
    {
      key: "nameservers",
      label: "Nameservers",
      sensitive: false,
      description: "Google Cloud DNS nameservers for this zone",
    },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "dns",
};
