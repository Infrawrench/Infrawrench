import { f, o, rt } from "@infrawrench/plugin-base";

export const R2BucketResourceType = rt({
  name: "R2 Bucket",
  id: "r2-bucket",
  description: "A Cloudflare R2 object storage bucket",
  fields: [
    f("name", "Name"),
    f("location", "Location Hint", { required: false }),
    f("createdOn", "Created", { required: false }),
  ],
  outputs: [o("bucketName", "Bucket Name"), o("s3Endpoint", "S3-compatible Endpoint")],
  supportsCreate: true,
  supportsStorageBrowser: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "r2-s3-credentials",
      displayName: "R2 S3-compatible Credentials",
      description: "S3-compatible endpoint and bucket name for connecting to R2",
      entries: [
        { envKey: "R2_BUCKET_NAME", outputKey: "bucketName", description: "R2 bucket name" },
        {
          envKey: "R2_S3_ENDPOINT",
          outputKey: "s3Endpoint",
          description: "S3-compatible endpoint URL",
        },
      ],
    },
  ],
  iconKey: "storage",
});
