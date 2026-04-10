import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ECRRepositoryResourceType: ResourceTypeDefinition = {
  id: "ecr-repository",
  displayName: "ECR Repository",
  pluralDisplayName: "ECR Repositories",
  description: "An Amazon Elastic Container Registry repository",
  fields: [
    { key: "repositoryName", label: "Repository Name", kind: "string", required: true },
    { key: "registryId", label: "Registry ID", kind: "string", required: false },
    { key: "imageCount", label: "Image Count", kind: "number", required: false },
    { key: "imageScanOnPush", label: "Scan on Push", kind: "boolean", required: false },
    { key: "encryptionType", label: "Encryption", kind: "string", required: false },
  ],
  outputs: [
    { key: "repositoryUri", label: "Repository URI", sensitive: false },
    { key: "repositoryArn", label: "Repository ARN", sensitive: false },
  ],
  dashboardPinnable: true,
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
  ],
};
