import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ArtifactRegistryRepoResourceType: ResourceTypeDefinition = {
  id: "artifact-registry-repo",
  displayName: "Artifact Registry Repository",
  pluralDisplayName: "Artifact Registry Repositories",
  description: "A Google Artifact Registry repository",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    {
      key: "format",
      label: "Format",
      kind: "enum",
      required: false,
      enumValues: ["DOCKER", "MAVEN", "NPM", "APT", "YUM", "PYTHON", "GO", "HELM"],
    },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "sizeBytes", label: "Size", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  supportsCreate: true,
};
