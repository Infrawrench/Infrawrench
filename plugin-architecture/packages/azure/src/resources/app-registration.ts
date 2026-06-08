import { f, o, rt } from "@infrawrench/plugin-base";

export const AppRegistrationResourceType = rt({
  name: "App Registration",
  pinnable: false,
  id: "azure-app-registration",
  description:
    "An Entra ID (Azure AD) application with a service principal — the Azure equivalent of an AWS IAM user or GCP service account. Use it for service-to-service auth via client credentials.",
  fields: [
    f("displayName", "Display Name"),
    f("appId", "Application (Client) ID"),
    f("objectId", "Object ID"),
    f("servicePrincipalId", "Service Principal ID", { required: false }),
    f("signInAudience", "Sign-in Audience", { required: false }),
    f("createdDateTime", "Created", { required: false }),
  ],
  outputs: [
    o("appId", "Client ID"),
    o("tenantId", "Tenant ID"),
    o("clientSecret", "Client Secret (credentials file)", {
      sensitive: true,
      description:
        "Creates a new client secret via Graph addPassword and emits a ready-to-use env-file with AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET. Each resolve creates one secret.",
    }),
  ],
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
});
