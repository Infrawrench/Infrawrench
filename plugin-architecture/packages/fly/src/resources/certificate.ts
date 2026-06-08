import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CertificateResourceType: ResourceTypeDefinition = {
  id: "certificate",
  displayName: "Certificate",
  pluralDisplayName: "Certificates",
  description: "A Fly.io TLS certificate for a custom app hostname",
  parentTypeId: "app",
  fields: [
    { key: "hostname", label: "Hostname", kind: "string", required: true },
    { key: "appName", label: "App", kind: "string", required: true },
    { key: "configured", label: "Configured", kind: "boolean", required: false },
    { key: "acmeDnsConfigured", label: "ACME DNS", kind: "boolean", required: false },
    { key: "certificateAuthority", label: "Authority", kind: "string", required: false },
    { key: "issued", label: "Issued", kind: "string", required: false },
    { key: "expires", label: "Expires", kind: "string", required: false },
    { key: "dnsProvider", label: "DNS Provider", kind: "string", required: false },
  ],
  outputs: [{ key: "hostname", label: "Hostname", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "certificate",
  supportsCreate: true,
};
