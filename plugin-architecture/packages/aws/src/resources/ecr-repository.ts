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
  outputs: [o("repositoryUri", "Repository URI"), o("repositoryArn", "Repository ARN")],
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
  ],
});
