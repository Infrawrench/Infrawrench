import { f, o, rt } from "@infrawrench/plugin-base";

export const ObjectStorageResourceType = rt({
  id: "object-storage-bucket",
  name: "Object Storage Bucket",
  plural: "Object Storage Buckets",
  description: "An OVHcloud Public Cloud S3-compatible storage container",
  fields: [
    f("name", "Bucket Name"),
    f("region", "Region"),
    f("objectsCount", "Objects", { kind: "number", required: false }),
    f("objectsSizeBytes", "Size (bytes)", { kind: "number", required: false }),
    f("virtualHost", "Virtual Host", { required: false }),
  ],
  outputs: [o("endpoint", "Endpoint URL")],
  supportsCreate: true,
  iconKey: "storage",
});
