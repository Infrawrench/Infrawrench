import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PsDeployRequestResourceType: ResourceTypeDefinition = {
  id: "ps-deploy-request",
  displayName: "Deploy Request",
  pluralDisplayName: "Deploy Requests",
  description: "A PlanetScale deploy request for applying branch schema changes",
  fields: [
    { key: "number", label: "Number", kind: "number", required: true },
    { key: "databaseName", label: "Database", kind: "string", required: true },
    { key: "branch", label: "Branch", kind: "string", required: false },
    { key: "intoBranch", label: "Into Branch", kind: "string", required: false },
    { key: "approved", label: "Approved", kind: "boolean", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "htmlUrl", label: "URL", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "updatedAt", label: "Updated At", kind: "string", required: false },
    { key: "deployedAt", label: "Deployed At", kind: "string", required: false },
    { key: "closedAt", label: "Closed At", kind: "string", required: false },
  ],
  outputs: [
    { key: "deployRequestNumber", label: "Deploy Request Number", sensitive: false },
    { key: "sourceBranch", label: "Source Branch", sensitive: false },
    { key: "targetBranch", label: "Target Branch", sensitive: false },
  ],
  parentTypeId: "ps-database",
  dashboardPinnable: true,
  iconKey: "planetscale",
};
