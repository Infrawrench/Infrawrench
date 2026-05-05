import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AppRegistrationResourceType: ResourceTypeDefinition = {
  id: "azure-app-registration",
  displayName: "App Registration",
  pluralDisplayName: "App Registrations",
  description:
    "An Entra ID (Azure AD) application with a service principal — the Azure equivalent of an AWS IAM user or GCP service account. Use it for service-to-service auth via client credentials.",
  fields: [
    { key: "displayName", label: "Display Name", kind: "string", required: true },
    { key: "appId", label: "Application (Client) ID", kind: "string", required: true },
    { key: "objectId", label: "Object ID", kind: "string", required: true },
    {
      key: "servicePrincipalId",
      label: "Service Principal ID",
      kind: "string",
      required: false,
    },
    { key: "signInAudience", label: "Sign-in Audience", kind: "string", required: false },
    { key: "createdDateTime", label: "Created", kind: "string", required: false },
  ],
  outputs: [
    { key: "appId", label: "Client ID", sensitive: false },
    { key: "tenantId", label: "Tenant ID", sensitive: false },
    {
      key: "clientSecret",
      label: "Client Secret (credentials file)",
      sensitive: true,
      description:
        "Creates a new client secret via Graph addPassword and emits a ready-to-use env-file with AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET. Each resolve creates one secret.",
    },
  ],
  dashboardPinnable: false,
  iconKey: "user",
  supportsCreate: true,
  credentialFormats: [
    {
      id: "client-secret",
      label: "Client Secret",
      description:
        "Creates a new client secret via Microsoft Graph and packages it with the tenant/client IDs as a ready-to-source env file.",
      mediaType: "ini",
      filenameTemplate: "{resource}.env",
    },
  ],
  secretExportTemplates: [
    {
      id: "azure-service-principal",
      displayName: "Azure Service Principal",
      description: "Environment variables for Azure SDK / CLI service-principal auth",
      entries: [
        { envKey: "AZURE_CLIENT_ID", outputKey: "appId" },
        { envKey: "AZURE_TENANT_ID", outputKey: "tenantId" },
        { envKey: "AZURE_CLIENT_SECRET", outputKey: "clientSecret" },
      ],
    },
  ],
};
