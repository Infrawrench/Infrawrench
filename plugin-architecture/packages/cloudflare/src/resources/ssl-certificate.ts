import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SSLCertificateResourceType: ResourceTypeDefinition = {
  id: "ssl-certificate",
  displayName: "SSL Certificate",
  pluralDisplayName: "SSL Certificates",
  description: "An SSL/TLS certificate managed by Cloudflare",
  fields: [
    { key: "hosts", label: "Hosts", kind: "string", required: true },
    { key: "issuer", label: "Issuer", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "expiresOn", label: "Expires", kind: "string", required: false },
    { key: "zoneName", label: "Zone", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  iconKey: "certificate",
};
