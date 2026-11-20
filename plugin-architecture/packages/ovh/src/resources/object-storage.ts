import { f, o, rt } from "@infrawrench/plugin-base";

export const ObjectStorageResourceType = rt({
  id: "object-storage-bucket",
  name: "Object Storage Bucket",
  plural: "Object Storage Buckets",
  description: "An OVHcloud Public Cloud S3-compatible storage container",
  equivalence: "object-storage",
  fields: [
    f("name", "Bucket Name"),
    f("region", "Region", { showcase: true, sizing: "region" }),
    f("objectsCount", "Objects", { showcase: true, kind: "number", required: false }),
    f("objectsSizeBytes", "Size (bytes)", { kind: "number", required: false }),
    f("virtualHost", "Virtual Host", { required: false }),
  ],
  outputs: [o("endpoint", "Endpoint URL")],
  supportsCreate: true,
  iconKey: "storage",
});
