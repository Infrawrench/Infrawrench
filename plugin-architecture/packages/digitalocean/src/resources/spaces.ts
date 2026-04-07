import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SpacesResourceType: ResourceTypeDefinition = {
  id: "spaces-bucket",
  displayName: "Spaces Bucket",
  pluralDisplayName: "Spaces Buckets",
  description: "A DigitalOcean Spaces object storage bucket",
  fields: [
    { key: "name", label: "Bucket Name", kind: "string", required: true },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
      enumValues: ["nyc3", "sfo3", "ams3", "fra1", "sgp1", "syd1"],
    },
    {
      key: "accessControl",
      label: "Access Control",
      kind: "enum",
      required: true,
      enumValues: ["private", "public-read"],
    },
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint URL", sensitive: false },
    { key: "accessKeyId", label: "Access Key ID", sensitive: true },
    { key: "secretAccessKey", label: "Secret Access Key", sensitive: true },
  ],
  parentTypeId: "project",
  dashboardPinnable: true,
  iconKey: "spaces",
  secretExportTemplates: [
    {
      id: "s3-compatible",
      displayName: "S3-Compatible Credentials",
      description: "AWS-style environment variables for S3-compatible access",
      entries: [
        { envKey: "AWS_ACCESS_KEY_ID", outputKey: "accessKeyId" },
        { envKey: "AWS_SECRET_ACCESS_KEY", outputKey: "secretAccessKey" },
        { envKey: "AWS_ENDPOINT_URL", outputKey: "endpoint", description: "S3-compatible endpoint URL" },
      ],
    },
  ],
};
