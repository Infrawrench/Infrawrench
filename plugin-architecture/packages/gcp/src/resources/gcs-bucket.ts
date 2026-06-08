import { f, o, rt } from "@infrawrench/plugin-base";

export const GcsBucketResourceType = rt({
  name: "Cloud Storage Bucket",
  id: "gcs-bucket",
  description: "A Google Cloud Storage bucket",
  fields: [
    f("name", "Name"),
    f("location", "Location", { required: false }),
    f("storageClass", "Storage Class", {
      kind: "enum",
      required: false,
      enumValues: ["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"],
    }),
    f("publicAccessPrevention", "Public Access Prevention", { required: false }),
    f("versioning", "Versioning", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("endpoint", "Endpoint URL"),
    o("bucketName", "Bucket Name"),
    o("serviceAccountKey", "Service Account Key (JSON)", {
      sensitive: true,
      description: "Created on demand via the IAM API",
    }),
  ],
  supportsCreate: true,
  supportsStorageBrowser: true,
  secretExportTemplates: [
    {
      id: "gcs-full",
      displayName: "GCS Credentials",
      description:
        "Service account key JSON and bucket name — a new key is created via the IAM API",
      entries: [
        {
          envKey: "GOOGLE_APPLICATION_CREDENTIALS_JSON",
          outputKey: "serviceAccountKey",
          description: "Service account key JSON (created on demand)",
        },
        { envKey: "GCS_BUCKET", outputKey: "bucketName" },
      ],
    },
    {
      id: "sa-key-only",
      displayName: "Service Account Key Only",
      description: "Just the service account key JSON — a new key is created via the IAM API",
      entries: [{ envKey: "GOOGLE_APPLICATION_CREDENTIALS_JSON", outputKey: "serviceAccountKey" }],
    },
  ],
});
