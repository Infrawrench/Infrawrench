import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ServiceAccountResourceType: ResourceTypeDefinition = {
  id: "gcp-service-account",
  displayName: "Service Account",
  pluralDisplayName: "Service Accounts",
  description: "A Google Cloud IAM service account",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "email", label: "Email", kind: "string", required: false },
    { key: "displayName", label: "Display Name", kind: "string", required: false },
    { key: "disabled", label: "Disabled", kind: "boolean", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
};
