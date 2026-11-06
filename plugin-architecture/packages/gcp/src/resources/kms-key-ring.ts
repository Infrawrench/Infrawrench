import { f, rt } from "@infrawrench/plugin-base";

export const KmsKeyRingResourceType = rt({
  name: "KMS Key Ring",
  pinnable: false,
  id: "kms-key-ring",
  iconKey: "key",
  description: "A Google Cloud KMS key ring containing cryptographic keys",
  fields: [
    f("name", "Name"),
    f("location", "Location", { showcase: true }),
    f("keyCount", "Key Count", { showcase: true, kind: "number", required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsDelete: false,
});
