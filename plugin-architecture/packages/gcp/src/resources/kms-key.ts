import { f, rt } from "@infrawrench/plugin-base";

export const KmsKeyResourceType = rt({
  name: "KMS Key",
  id: "kms-key",
  description: "A Google Cloud KMS cryptographic key",
  fields: [
    f("name", "Name"),
    f("keyRing", "Key Ring"),
    f("location", "Location", { required: false }),
    f("purpose", "Purpose", { required: false }),
    f("algorithm", "Algorithm", { required: false }),
    f("protectionLevel", "Protection Level", { required: false }),
    f("state", "State", { required: false }),
    f("rotationPeriod", "Rotation Period", { required: false }),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "keyRing", targetTypeId: "kms-key-ring", targetKey: "name", label: "in key ring" },
  ],
  parentTypeId: "kms-key-ring",
  supportsCreate: true,
});
