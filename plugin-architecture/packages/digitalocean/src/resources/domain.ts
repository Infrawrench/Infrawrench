import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DomainResourceType: ResourceTypeDefinition = {
  id: "domain",
  displayName: "Domain",
  pluralDisplayName: "Domains",
  description: "A DigitalOcean DNS domain",
  fields: [
    { key: "name", label: "Domain", kind: "string", required: true },
    { key: "ttl", label: "Default TTL", kind: "number", required: false },
    { key: "zoneFile", label: "Zone File", kind: "string", required: false },
  ],
  outputs: [
    {
      key: "nameservers",
      label: "Nameservers",
      sensitive: false,
      description: "DigitalOcean nameservers for this domain",
    },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "dns",
};
