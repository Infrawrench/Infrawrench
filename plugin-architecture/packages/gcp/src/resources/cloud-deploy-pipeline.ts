import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudDeployPipelineResourceType: ResourceTypeDefinition = {
  id: "cloud-deploy-pipeline",
  displayName: "Cloud Deploy Pipeline",
  pluralDisplayName: "Cloud Deploy Pipelines",
  description: "A Google Cloud Deploy continuous delivery pipeline",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "stageCount", label: "Stages", kind: "number", required: false },
    { key: "stages", label: "Stage Names", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
};
