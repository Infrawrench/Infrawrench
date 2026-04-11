import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ObjectStorageResourceType: ResourceTypeDefinition = {
  id: "object-storage-bucket",
  displayName: "Object Storage Bucket",
  pluralDisplayName: "Object Storage Buckets",
  description: "A Scaleway Object Storage bucket (S3-compatible)",
  fields: [
    { key: "name", label: "Bucket Name", kind: "string", required: true },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
      enumValues: ["fr-par", "nl-ams", "pl-waw"],
    },
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint URL", sensitive: false },
    { key: "accessKeyId", label: "Access Key ID", sensitive: true },
    { key: "secretAccessKey", label: "Secret Access Key", sensitive: true },
  ],
  dashboardPinnable: true,
  iconKey: "storage",
  secretExportTemplates: [
    {
      id: "s3-compatible",
      displayName: "S3-Compatible Credentials",
      description: "AWS-style environment variables for S3-compatible access",
      entries: [
        { envKey: "AWS_ACCESS_KEY_ID", outputKey: "accessKeyId" },
        { envKey: "AWS_SECRET_ACCESS_KEY", outputKey: "secretAccessKey" },
        {
          envKey: "AWS_ENDPOINT_URL",
          outputKey: "endpoint",
          description: "S3-compatible endpoint URL",
        },
      ],
    },
  ],
};
