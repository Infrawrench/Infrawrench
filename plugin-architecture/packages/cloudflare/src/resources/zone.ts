import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ZoneResourceType: ResourceTypeDefinition = {
  id: "zone",
  displayName: "Zone",
  pluralDisplayName: "Zones",
  description: "A Cloudflare DNS zone (domain)",
  fields: [
    { key: "name", label: "Domain", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "plan", label: "Plan", kind: "string", required: false },
    { key: "nameservers", label: "Nameservers", kind: "string", required: false },
    { key: "type", label: "Zone Type", kind: "string", required: false },
    { key: "paused", label: "Paused", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "zoneId", label: "Zone ID", sensitive: false },
    {
      key: "nameservers",
      label: "Nameservers",
      sensitive: false,
      description: "Cloudflare nameservers assigned to this zone",
    },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "dns",
  secretExportTemplates: [
    {
      id: "zone-id",
      displayName: "Zone ID",
      description: "Zone ID for Cloudflare API / wrangler operations",
      entries: [{ envKey: "CLOUDFLARE_ZONE_ID", outputKey: "zoneId" }],
    },
  ],
};
