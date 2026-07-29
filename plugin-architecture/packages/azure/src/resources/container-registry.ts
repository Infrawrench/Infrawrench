import { f, o, rt } from "@infrawrench/plugin-base";

export const ContainerRegistryResourceType = rt({
  name: "Container Registry",
  plural: "Container Registries",
  id: "azure-container-registry",
  description: "An Azure Container Registry (ACR)",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("provisioningState", "Provisioning State"),
    f("adminEnabled", "Admin Enabled", { kind: "boolean", required: false }),
    f("publicNetworkAccess", "Public Access", { required: false }),
  ],
  outputs: [
    o("loginServer", "Login Server"),
    o("username", "Docker Username", { sensitive: true }),
    o("password", "Docker Password", { sensitive: true }),
    o("dockerConfigJson", "Docker Config JSON", {
      sensitive: true,
      description:
        "Admin docker credentials as a .dockerconfigjson document — usable directly as a kubernetes.io/dockerconfigjson pull secret.",
    }),
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
