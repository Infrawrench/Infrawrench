import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KmsKeyRingResourceType: ResourceTypeDefinition = {
  id: "kms-key-ring",
  displayName: "KMS Key Ring",
  pluralDisplayName: "KMS Key Rings",
  description: "A Google Cloud KMS key ring containing cryptographic keys",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "keyCount", label: "Key Count", kind: "number", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
};
