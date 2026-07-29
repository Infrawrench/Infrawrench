import { f, o, rt } from "@infrawrench/plugin-base";

export const ECRRepositoryResourceType = rt({
  name: "ECR Repository",
  plural: "ECR Repositories",
  id: "ecr-repository",
  description: "An Amazon Elastic Container Registry repository",
  fields: [
    f("repositoryName", "Repository Name"),
    f("registryId", "Registry ID", { required: false }),
    f("imageCount", "Image Count", { kind: "number", required: false }),
    f("imageScanOnPush", "Scan on Push", { kind: "boolean", required: false }),
    f("encryptionType", "Encryption", { required: false }),
  ],
  outputs: [
    o("repositoryUri", "Repository URI"),
    o("repositoryArn", "Repository ARN"),
    o("serverUrl", "Registry Server", {
      description: "Registry host for docker login — <accountId>.dkr.ecr.<region>.amazonaws.com",
    }),
    o("username", "Docker Username", {
      sensitive: true,
      description: 'Always the literal "AWS" — ECR docker logins authenticate as the AWS user',
    }),
    o("password", "Docker Password", {
      sensitive: true,
      description:
        "Docker login password minted via ECR GetAuthorizationToken — valid for 12 hours",
    }),
    o("dockerConfigJson", "Docker Config JSON", {
      sensitive: true,
      description:
        "Docker credentials as a compact .dockerconfigjson document — usable directly as a " +
        "kubernetes.io/dockerconfigjson pull secret. The embedded token is valid for 12 hours.",
    }),
  ],
  supportsCreate: true,
  iconKey: "container-registry",
  secretExportTemplates: [
    {
      id: "ecr-registry",
      displayName: "ECR Registry",
      description: "Container registry URI for pushing/pulling images",
      entries: [
        { envKey: "ECR_REGISTRY_URI", outputKey: "repositoryUri", description: "Repository URI" },
        { envKey: "ECR_REGISTRY_ARN", outputKey: "repositoryArn", description: "Repository ARN" },
      ],
    },
    {
      id: "docker-login",
      displayName: "Docker Login",
      description:
        "Registry server + credentials for docker login / push / pull (password valid 12 hours)",
      entries: [
        { envKey: "DOCKER_REGISTRY_SERVER", outputKey: "serverUrl" },
        { envKey: "DOCKER_USERNAME", outputKey: "username" },
        { envKey: "DOCKER_PASSWORD", outputKey: "password" },
      ],
    },
  ],
});
