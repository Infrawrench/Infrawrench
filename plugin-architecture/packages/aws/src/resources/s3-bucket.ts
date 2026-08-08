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
  // Covers every REST, website, dual-stack and accelerate endpoint form:
  // `b.s3.amazonaws.com`, `b.s3.eu-west-1.amazonaws.com`,
  // `b.s3-website-us-east-1.amazonaws.com`, `b.s3-website.us-east-1.amazonaws.com`,
  // `b.s3.dualstack.us-east-1.amazonaws.com`, `b.s3-accelerate.amazonaws.com`,
  // `b.s3-accelerate.dualstack.amazonaws.com`. Bucket names may contain dots,
  // so the capture is greedy up to the `.s3` label.
  dnsServiceHosts: [
    {
      id: "s3-endpoint",
      label: "S3 bucket endpoint",
      hostPattern: String.raw`([a-z0-9][a-z0-9.-]*)\.s3(?:-accelerate(?:\.dualstack)?|(?:[.-]website)?(?:\.dualstack)?(?:[.-][a-z0-9-]+)?)\.amazonaws\.com`,
      reason:
        "S3 bucket names are globally unique and freed the moment the bucket is deleted, so anyone can recreate it and serve their own objects from your hostname.",
    },
  ],
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
