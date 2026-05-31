import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CustomHostnameResourceType: ResourceTypeDefinition = {
  id: "custom-hostname",
  displayName: "Custom Hostname",
  pluralDisplayName: "Custom Hostnames",
  description: "A custom hostname (SSL for SaaS) on a Cloudflare zone",
  fields: [
    { key: "hostname", label: "Hostname", kind: "string", required: true, editable: false },
    { key: "status", label: "Status", kind: "string", required: true, editable: false },
    { key: "sslStatus", label: "SSL Status", kind: "string", required: false, editable: false },
    { key: "sslMethod", label: "SSL Method", kind: "string", required: false },
    { key: "sslType", label: "SSL Type", kind: "string", required: false, editable: false },
    { key: "createdAt", label: "Created", kind: "string", required: false, editable: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "hostname",
};
