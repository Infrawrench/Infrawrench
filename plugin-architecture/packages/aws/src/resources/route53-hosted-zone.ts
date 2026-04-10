import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const Route53HostedZoneResourceType: ResourceTypeDefinition = {
  id: "route53-hosted-zone",
  displayName: "Route 53 Hosted Zone",
  pluralDisplayName: "Route 53 Hosted Zones",
  description: "An Amazon Route 53 DNS hosted zone",
  fields: [
    { key: "name", label: "Domain Name", kind: "string", required: true },
    { key: "hostedZoneId", label: "Hosted Zone ID", kind: "string", required: true },
    { key: "recordCount", label: "Record Count", kind: "number", required: false },
    { key: "isPrivate", label: "Private Zone", kind: "boolean", required: false },
    { key: "comment", label: "Comment", kind: "string", required: false },
  ],
  outputs: [
    { key: "hostedZoneId", label: "Hosted Zone ID", sensitive: false },
    { key: "nameServers", label: "Name Servers", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "dns",
};
