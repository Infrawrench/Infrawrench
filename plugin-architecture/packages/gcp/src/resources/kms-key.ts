import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KmsKeyResourceType: ResourceTypeDefinition = {
  id: "kms-key",
  displayName: "KMS Key",
  pluralDisplayName: "KMS Keys",
  description: "A Google Cloud KMS cryptographic key",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "keyRing", label: "Key Ring", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: false },
    { key: "purpose", label: "Purpose", kind: "string", required: false },
    { key: "algorithm", label: "Algorithm", kind: "string", required: false },
    { key: "protectionLevel", label: "Protection Level", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "rotationPeriod", label: "Rotation Period", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  parentTypeId: "kms-key-ring",
  supportsCreate: true,
};
