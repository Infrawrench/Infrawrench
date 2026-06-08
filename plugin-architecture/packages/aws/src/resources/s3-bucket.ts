import { f, o, rt } from "@infrawrench/plugin-base";

export const S3BucketResourceType = rt({
  name: "S3 Bucket",
  id: "s3-bucket",
  description: "An Amazon S3 object storage bucket",
  fields: [
    f("name", "Bucket Name"),
    f("region", "Region", { required: false }),
    f("creationDate", "Created", { required: false }),
  ],
  outputs: [o("bucketArn", "Bucket ARN"), o("endpoint", "Endpoint URL")],
  iconKey: "storage",
  supportsStorageBrowser: true,
  supportsCreate: true,
  supportsMetrics: true,
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
});
