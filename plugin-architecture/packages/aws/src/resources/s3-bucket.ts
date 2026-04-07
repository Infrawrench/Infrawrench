import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const S3BucketResourceType: ResourceTypeDefinition = {
  id: "s3-bucket",
  displayName: "S3 Bucket",
  pluralDisplayName: "S3 Buckets",
  description: "An Amazon S3 object storage bucket",
  fields: [
    { key: "name", label: "Bucket Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "creationDate", label: "Created", kind: "string", required: false },
  ],
  outputs: [
    { key: "bucketArn", label: "Bucket ARN", sensitive: false },
    { key: "endpoint", label: "Endpoint URL", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "storage",
  supportsStorageBrowser: true,
  secretExportTemplates: [
    {
      id: "s3-env",
      displayName: "S3 Bucket Credentials",
      description: "Environment variables for accessing this S3 bucket",
      entries: [
        { envKey: "AWS_S3_BUCKET", outputKey: "bucketArn", description: "Bucket ARN" },
        { envKey: "AWS_S3_ENDPOINT", outputKey: "endpoint", description: "S3 endpoint URL" },
      ],
    },
  ],
};
