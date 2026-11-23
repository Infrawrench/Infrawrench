import { f, o, rt } from "@infrawrench/plugin-base";

export const ContainerRegistryResourceType = rt({
  name: "Container Registry",
  plural: "Container Registries",
  id: "azure-container-registry",
  description: "An Azure Container Registry (ACR)",
  equivalence: "container-registry",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    f("location", "Location", { showcase: true, sizing: "region" }),
    f("sku", "SKU", { showcase: true }),
    f("provisioningState", "Provisioning State", { showcase: true }),
    f("adminEnabled", "Admin Enabled", { kind: "boolean", required: false }),
    f("publicNetworkAccess", "Public Access", { required: false }),
    // From the registry's quota usages (`listUsages`): `Size` in bytes and
    // `Webhooks`, each with the limit Azure applies to the registry's tier.
    // https://learn.microsoft.com/rest/api/container-registry/registries/list-usages
    // (read 2026-11-23)
    f("storageUsedBytes", "Storage Used", {
      kind: "number",
      required: false,
      editable: false,
      usage: { limit: { field: "storageQuotaBytes" }, unit: "bytes", label: "Storage" },
    }),
    f("storageQuotaBytes", "Storage Quota", {
      kind: "number",
      required: false,
      editable: false,
      description:
        "Storage the tier includes, as the registry reports it (Basic 10 GiB, Standard 100 GiB, Premium 500 GiB); more is billed per GiB",
    }),
    f("webhookCount", "Webhooks", {
      kind: "number",
      required: false,
      editable: false,
      usage: { limit: { field: "webhookLimit" }, unit: "webhooks" },
    }),
    f("webhookLimit", "Webhook Limit", { kind: "number", required: false, editable: false }),
  ],
  outputs: [
    o("loginServer", "Login Server"),
    o("username", "Docker Username", { sensitive: true }),
    o("password", "Docker Password", { sensitive: true }),
    o("dockerConfigJson", "Docker Config JSON", {
      sensitive: true,
      description:
        "Admin docker credentials as a .dockerconfigjson document, usable directly as a kubernetes.io/dockerconfigjson pull secret.",
    }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  iconKey: "container-registry",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "acr-login-server",
      displayName: "ACR Login Server",
      description: "Login server hostname for docker push / pull",
      entries: [{ envKey: "ACR_LOGIN_SERVER", outputKey: "loginServer" }],
    },
    {
      id: "docker-login",
      displayName: "Docker Login",
      description: "Registry server + admin credentials for docker login / push / pull",
      entries: [
        { envKey: "DOCKER_REGISTRY_SERVER", outputKey: "loginServer" },
        { envKey: "DOCKER_USERNAME", outputKey: "username" },
        { envKey: "DOCKER_PASSWORD", outputKey: "password" },
      ],
    },
  ],
});
