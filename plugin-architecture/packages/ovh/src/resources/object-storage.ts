import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ObjectStorageResourceType: ResourceTypeDefinition = {
  id: "object-storage-bucket",
  displayName: "Object Storage Bucket",
  pluralDisplayName: "Object Storage Buckets",
  description: "An OVHcloud Public Cloud S3-compatible storage container",
  fields: [
    { key: "name", label: "Bucket Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "objectsCount", label: "Objects", kind: "number", required: false },
    { key: "objectsSizeBytes", label: "Size (bytes)", kind: "number", required: false },
    { key: "virtualHost", label: "Virtual Host", kind: "string", required: false },
  ],
  outputs: [{ key: "endpoint", label: "Endpoint URL", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "storage",
};
