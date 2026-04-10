import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const WorkflowResourceType: ResourceTypeDefinition = {
  id: "workflow",
  displayName: "Workflow",
  pluralDisplayName: "Workflows",
  description: "A Google Cloud Workflows serverless workflow orchestration",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "revisionId", label: "Revision ID", kind: "string", required: false },
    { key: "serviceAccount", label: "Service Account", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
};
