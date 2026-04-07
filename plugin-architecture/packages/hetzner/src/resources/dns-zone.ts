import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DnsZoneResourceType: ResourceTypeDefinition = {
  id: "dns-zone",
  displayName: "DNS Zone",
  pluralDisplayName: "DNS Zones",
  description: "A Hetzner DNS zone (domain)",
  fields: [
    { key: "name", label: "Domain", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "ttl", label: "Default TTL", kind: "number", required: false },
    { key: "isSecondary", label: "Secondary", kind: "boolean", required: false },
    { key: "recordCount", label: "Record Count", kind: "number", required: false },
  ],
  outputs: [
    {
      key: "nameservers",
      label: "Nameservers",
      sensitive: false,
      description: "Hetzner DNS nameservers for this zone",
    },
  ],
  dashboardPinnable: true,
  iconKey: "dns",
};
