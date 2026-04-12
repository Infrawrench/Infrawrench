import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VercelDomainResourceType: ResourceTypeDefinition = {
  id: "vercel-domain",
  displayName: "Domain",
  pluralDisplayName: "Domains",
  description: "A domain registered or configured in Vercel",
  fields: [
    { key: "name", label: "Domain Name", kind: "string", required: true },
    { key: "verified", label: "Verified", kind: "string", required: false },
    { key: "serviceType", label: "Service Type", kind: "string", required: false },
    { key: "nameservers", label: "Nameservers", kind: "string", required: false },
    {
      key: "intendedNameservers",
      label: "Intended Nameservers",
      kind: "string",
      required: false,
    },
    { key: "renew", label: "Auto-Renew", kind: "string", required: false },
    { key: "expiresAt", label: "Expires At", kind: "string", required: false },
    { key: "boughtAt", label: "Bought At", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
  ],
  outputs: [
    { key: "domainName", label: "Domain Name", sensitive: false },
    { key: "nameservers", label: "Nameservers", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "domain",
};
