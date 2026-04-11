import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SecretManagerSecretResourceType: ResourceTypeDefinition = {
  id: "secret-manager-secret",
  displayName: "Secret Manager Secret",
  pluralDisplayName: "Secret Manager Secrets",
  description: "A Google Cloud Secret Manager secret",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "replicationType", label: "Replication Type", kind: "string", required: false },
    { key: "versionCount", label: "Versions", kind: "number", required: false },
  ],
  outputs: [{ key: "latestVersion", label: "Latest Version Value", sensitive: true }],
  dashboardPinnable: false,
};
