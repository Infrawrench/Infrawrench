import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DnsZoneResourceType: ResourceTypeDefinition = {
  id: "dns-zone",
  displayName: "DNS Zone",
  pluralDisplayName: "DNS Zones",
  description: "A Scaleway DNS zone (domain)",
  fields: [
    { key: "domain", label: "Domain", kind: "string", required: true },
    { key: "subdomain", label: "Subdomain", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "ns", label: "Nameservers", kind: "string", required: false },
    { key: "nsDefault", label: "NS Default", kind: "string", required: false },
    { key: "nsMaster", label: "NS Master", kind: "string", required: false },
  ],
  outputs: [
    {
      key: "nameservers",
      label: "Nameservers",
      sensitive: false,
      description: "Scaleway DNS nameservers for this zone",
    },
  ],
  dashboardPinnable: true,
  iconKey: "dns",
};
