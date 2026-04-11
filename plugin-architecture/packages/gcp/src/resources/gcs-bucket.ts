import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const GcsBucketResourceType: ResourceTypeDefinition = {
  id: "gcs-bucket",
  displayName: "Cloud Storage Bucket",
  pluralDisplayName: "Cloud Storage Buckets",
  description: "A Google Cloud Storage bucket",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: false },
    {
      key: "storageClass",
      label: "Storage Class",
      kind: "enum",
      required: false,
      enumValues: ["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"],
    },
    {
      key: "publicAccessPrevention",
      label: "Public Access Prevention",
      kind: "string",
      required: false,
    },
    { key: "versioning", label: "Versioning", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint URL", sensitive: false },
    { key: "bucketName", label: "Bucket Name", sensitive: false },
    {
      key: "serviceAccountKey",
      label: "Service Account Key (JSON)",
      sensitive: true,
      description: "Created on demand via the IAM API",
    },
  ],
  dashboardPinnable: true,
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
};
