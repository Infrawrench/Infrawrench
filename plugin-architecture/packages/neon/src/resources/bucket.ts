import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonBucketResourceType = rt({
  name: "Bucket",
  plural: "Buckets",
  id: "neon-bucket",
  description: "A Neon Object Storage bucket — S3-compatible storage that branches with your data",
  fields: [
    f("name", "Name"),
    f("accessLevel", "Access Level", {
      kind: "enum",
      enumValues: ["private", "public_read"],
      required: false,
    }),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
    f("region", "Region", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("bucketName", "Bucket Name"), o("s3Endpoint", "S3 Endpoint"), o("region", "Region")],
  parentTypeId: "neon-branch",
  supportsCreate: true,
  supportsDelete: true,
  supportsStorageBrowser: true,
  iconKey: "storage",
  secretExportTemplates: [
    {
      id: "s3-compatible",
      displayName: "S3-Compatible Endpoint",
      description:
        "S3 endpoint and region for this bucket. Pair with a Neon credential for the access keys; Neon requires path-style addressing.",
      entries: [
        { envKey: "AWS_ENDPOINT_URL", outputKey: "s3Endpoint" },
        { envKey: "AWS_REGION", outputKey: "region" },
        { envKey: "BUCKET_NAME", outputKey: "bucketName" },
      ],
    },
  ],
});
