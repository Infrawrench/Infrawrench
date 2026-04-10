import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ManagedIdentityResourceType: ResourceTypeDefinition = {
  id: "azure-managed-identity",
  displayName: "Managed Identity",
  pluralDisplayName: "Managed Identities",
  description: "An Azure user-assigned managed identity for secure, passwordless authentication",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
  ],
  outputs: [
    { key: "clientId", label: "Client ID", sensitive: false },
    { key: "principalId", label: "Principal ID", sensitive: false },
    { key: "tenantId", label: "Tenant ID", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "user",
  supportsCreate: true,
};
