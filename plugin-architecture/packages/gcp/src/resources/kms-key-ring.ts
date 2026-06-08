import { f, o, rt } from "@infrawrench/plugin-base";

export const KmsKeyRingResourceType = rt({
  name: "KMS Key Ring",
  pinnable: false,
  id: "kms-key-ring",
  description: "A Google Cloud KMS key ring containing cryptographic keys",
  fields: [
    f("name", "Name"),
    f("location", "Location"),
    f("keyCount", "Key Count", { kind: "number", required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsDelete: false,
});
