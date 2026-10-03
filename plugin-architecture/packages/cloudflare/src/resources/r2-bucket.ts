import { f, o, rt } from "@infrawrench/plugin-base";

export const R2BucketResourceType = rt({
  name: "R2 Bucket",
  id: "r2-bucket",
  description: "A Cloudflare R2 object storage bucket",
  fields: [
    f("name", "Name", { editable: false }),
    f("location", "Location Hint", { required: false, editable: false }),
    f("storageClass", "Default Storage Class", {
      kind: "enum",
      required: false,
      enumValues: ["Standard", "InfrequentAccess"],
      description:
        "Storage class new uploads get. Infrequent Access stores data for less but bills retrieval and has a 30-day minimum. Existing objects keep their class.",
    }),
    f("jurisdiction", "Jurisdiction", { required: false, editable: false }),
    f("createdOn", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("bucketName", "Bucket Name"),
    o("s3Endpoint", "S3-compatible Endpoint"),
    o("publicDevUrl", "Public r2.dev URL", {
      description: "The bucket's r2.dev development URL, when public access is enabled",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
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
