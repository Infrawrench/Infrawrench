import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NetlifyDnsZoneResourceType: ResourceTypeDefinition = {
  id: "netlify-dns-zone",
  displayName: "DNS Zone",
  pluralDisplayName: "DNS Zones",
  description: "A Netlify Managed DNS zone",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "domain", label: "Domain", kind: "string", required: false },
    { key: "dnsServers", label: "DNS Servers", kind: "string", required: false },
    {
      key: "supportedRecordTypes",
      label: "Supported Record Types",
      kind: "string",
      required: false,
    },
    { key: "ipv6Enabled", label: "IPv6 Enabled", kind: "boolean", required: false },
    { key: "dedicated", label: "Dedicated", kind: "boolean", required: false },
    { key: "accountName", label: "Team", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "updatedAt", label: "Updated At", kind: "string", required: false },
  ],
  outputs: [
    { key: "zoneId", label: "Zone ID", sensitive: false },
    { key: "domain", label: "Domain", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "dns",
};
