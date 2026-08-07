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
  // The virtual-hosted form (`bucket.storage.googleapis.com`) and the older
  // `commondatastorage` alias. Bucket names may contain dots.
  dnsServiceHosts: [
    {
      id: "gcs-endpoint",
      label: "Cloud Storage bucket endpoint",
      hostPattern: String.raw`([a-z0-9][a-z0-9._-]*)\.(?:storage|commondatastorage)\.googleapis\.com`,
      reason:
        "Cloud Storage bucket names are globally unique and released on delete, so anyone can recreate the bucket and serve their own objects from your hostname.",
    },
  ],
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
  postureChecks: [
    {
      id: "gcs-public-access-prevention-off",
      title: "Public access prevention not enforced",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "publicAccessPrevention", when: "notEquals", value: "enforced" }],
      reason:
        "Public access prevention is not enforced on this bucket, so a single IAM binding or ACL can make objects world-readable. Enforce it unless the bucket intentionally serves public content.",
    },
  ],
});
