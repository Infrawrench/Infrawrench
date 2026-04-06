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
    { key: "publicAccessPrevention", label: "Public Access Prevention", kind: "string", required: false },
    { key: "versioning", label: "Versioning", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint URL", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsStorageBrowser: true,
};
