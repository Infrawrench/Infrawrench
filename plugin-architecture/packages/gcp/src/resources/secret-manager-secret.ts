import { f, o, rt } from "@infrawrench/plugin-base";

export const SecretManagerSecretResourceType = rt({
  name: "Secret Manager Secret",
  pinnable: false,
  id: "secret-manager-secret",
  description: "A Google Cloud Secret Manager secret",
  fields: [
    f("name", "Name"),
    f("replicationType", "Replication Type", { required: false }),
    f("versionCount", "Versions", { kind: "number", required: false }),
  ],
  outputs: [o("latestVersion", "Latest Version Value", { sensitive: true })],
  supportsCreate: true,
});
