import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudBuildTriggerResourceType: ResourceTypeDefinition = {
  id: "cloud-build-trigger",
  displayName: "Cloud Build Trigger",
  pluralDisplayName: "Cloud Build Triggers",
  description: "A Google Cloud Build trigger for CI/CD pipelines",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "disabled", label: "Disabled", kind: "boolean", required: false },
    { key: "triggerType", label: "Trigger Type", kind: "string", required: false },
    { key: "repoName", label: "Repository", kind: "string", required: false },
    { key: "branchName", label: "Branch", kind: "string", required: false },
    { key: "filename", label: "Config File", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
};
