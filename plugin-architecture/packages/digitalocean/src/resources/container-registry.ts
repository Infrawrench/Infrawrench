import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The account's DigitalOcean Container Registry (DOCR). DO allows at most one
 * registry per account — GET /v2/registry returns it or 404s — so the lister
 * yields zero or one instance, and delete verifies the account's current
 * registry name before firing the id-less DELETE /v2/registry. Not
 * project-scoped in DO (unlike droplets/DOKS/etc.), hence no parentTypeId.
 */
export const ContainerRegistryResourceType = rt({
  name: "Container Registry",
  plural: "Container Registries",
  id: "container-registry",
  description: "The account's DigitalOcean Container Registry — one per account",
  fields: [
    f("name", "Name"),
    f("subscriptionTier", "Subscription Tier", {
      kind: "enum",
      enumValues: ["starter", "basic", "professional"],
      required: false,
    }),
    f("region", "Region", { required: false }),
    f("storageUsageBytes", "Storage Used", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [
    o("endpoint", "Endpoint", {
      description: "Registry namespace for image tags, e.g. registry.digitalocean.com/<name>",
    }),
    o("serverUrl", "Registry Server"),
    o("dockerConfigJson", "Docker Config JSON", {
      sensitive: true,
      description:
        "Read/write docker credentials as a .dockerconfigjson document — usable directly as a kubernetes.io/dockerconfigjson pull secret.",
    }),
    o("username", "Docker Username", { sensitive: true }),
    o("password", "Docker Password", { sensitive: true }),
  ],
  showInSidebar: true,
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "container-registry",
  secretExportTemplates: [
    {
      id: "docker-login",
      displayName: "Docker Login",
      description: "Registry server + read/write credentials for docker login / push / pull",
      entries: [
        { envKey: "DOCKER_REGISTRY_SERVER", outputKey: "serverUrl" },
        { envKey: "DOCKER_USERNAME", outputKey: "username" },
        { envKey: "DOCKER_PASSWORD", outputKey: "password" },
      ],
    },
  ],
});
