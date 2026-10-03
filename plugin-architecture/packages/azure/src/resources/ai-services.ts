import { f, o, rt } from "@infrawrench/plugin-base";

export const AIServicesAccountResourceType = rt({
  name: "AI Services Account",
  id: "azure-ai-services",
  description:
    "An Azure AI Foundry / Azure OpenAI / Azure AI services account (Microsoft.CognitiveServices/accounts) and the model deployments it hosts",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("kind", "Kind", { description: "Account kind, e.g. AIServices, OpenAI, Speech" }),
    f("sku", "SKU"),
    f("provisioningState", "Provisioning State"),
    f("customSubDomainName", "Custom Subdomain", { required: false }),
    f("publicNetworkAccess", "Public Network Access", { required: false }),
    f("localAuthEnabled", "Key Authentication", {
      kind: "boolean",
      required: false,
      description: "Whether API keys are accepted. Off means Entra ID tokens only",
    }),
    f("deploymentCount", "Model Deployments", { kind: "number", required: false }),
    f("deployments", "Deployments", {
      required: false,
      description: "Model deployments on the account: name (model version, SKU x capacity)",
    }),
    f("managedIdentities", "Managed Identities", { required: false }),
  ],
  outputs: [
    o("endpoint", "Endpoint"),
    o("apiKey", "API Key", { sensitive: true }),
    o("resourceId", "Resource ID", { hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    {
      fieldKey: "managedIdentities",
      targetTypeId: "azure-managed-identity",
      targetKey: "name",
      label: "runs as",
    },
  ],
  iconKey: "model",
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "azure-openai",
      displayName: "Azure OpenAI",
      description: "Endpoint and key for the Azure OpenAI / Foundry SDKs",
      entries: [
        { envKey: "AZURE_OPENAI_ENDPOINT", outputKey: "endpoint" },
        { envKey: "AZURE_OPENAI_API_KEY", outputKey: "apiKey" },
      ],
    },
  ],
  postureChecks: [
    {
      id: "azure-ai-services-key-auth",
      title: "API key authentication enabled",
      severity: "low",
      category: "other",
      conditions: [{ fieldKey: "localAuthEnabled", when: "truthy" }],
      reason:
        "The account accepts long-lived API keys alongside Entra ID tokens; a leaked key grants model access (and spend) until it is regenerated.",
    },
  ],
});
