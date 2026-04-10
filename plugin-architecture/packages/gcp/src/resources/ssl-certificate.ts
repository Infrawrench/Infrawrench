import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SslCertificateResourceType: ResourceTypeDefinition = {
  id: "ssl-certificate",
  displayName: "SSL Certificate",
  pluralDisplayName: "SSL Certificates",
  description: "A Google Cloud managed or self-managed SSL certificate",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "domains", label: "Domains", kind: "string", required: false },
    { key: "expireTime", label: "Expires", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
};
