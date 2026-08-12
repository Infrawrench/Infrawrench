import { f, o, rt } from "@infrawrench/plugin-base";

export const ManagedIdentityResourceType = rt({
  name: "Managed Identity",
  plural: "Managed Identities",
  id: "azure-managed-identity",
  description: "An Azure user-assigned managed identity for secure, passwordless authentication",
  fields: [f("name", "Name"), f("resourceGroup", "Resource Group"), f("location", "Location")],
  outputs: [
    o("clientId", "Client ID"),
    o("principalId", "Principal ID"),
    o("tenantId", "Tenant ID"),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  // ARM returns no timestamps and no role assignments for user-assigned
  // identities, so the review lists them and joins ownership; everything else
  // reads as unknown.
  principalRole: { role: "service-account" },
  iconKey: "user",
  supportsCreate: true,
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-vm",
      verb: "Assign to VM",
    },
  ],
});
