import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const R2BucketResourceType: ResourceTypeDefinition = {
  id: "r2-bucket",
  displayName: "R2 Bucket",
  pluralDisplayName: "R2 Buckets",
  description: "A Cloudflare R2 object storage bucket",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location Hint", kind: "string", required: false },
    { key: "createdOn", label: "Created", kind: "string", required: false },
  ],
  outputs: [
    { key: "bucketName", label: "Bucket Name", sensitive: false },
    { key: "s3Endpoint", label: "S3-compatible Endpoint", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsStorageBrowser: true,
  secretExportTemplates: [
    {
      id: "r2-s3-credentials",
      displayName: "R2 S3-compatible Credentials",
      description: "S3-compatible endpoint and bucket name for connecting to R2",
      entries: [
        { envKey: "R2_BUCKET_NAME", outputKey: "bucketName", description: "R2 bucket name" },
        { envKey: "R2_S3_ENDPOINT", outputKey: "s3Endpoint", description: "S3-compatible endpoint URL" },
      ],
    },
  ],
  iconKey: "storage",
};
