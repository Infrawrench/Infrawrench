import { f, o, rt } from "@infrawrench/plugin-base";

const REGIONS = ["fr-par", "nl-ams", "pl-waw"];

export const ObjectStorageResourceType = rt({
  id: "object-storage-bucket",
  name: "Object Storage Bucket",
  plural: "Object Storage Buckets",
  description: "A Scaleway Object Storage bucket (S3-compatible)",
  fields: [f("name", "Bucket Name"), f("region", "Region", { kind: "enum", enumValues: REGIONS })],
  outputs: [
    o("endpoint", "Endpoint URL"),
    o("accessKeyId", "Access Key ID", { sensitive: true }),
    o("secretAccessKey", "Secret Access Key", { sensitive: true }),
  ],
  supportsCreate: true,
  supportsStorageBrowser: true,
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
});
