import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PagesDeploymentResourceType: ResourceTypeDefinition = {
  id: "pages-deployment",
  displayName: "Pages Deployment",
  pluralDisplayName: "Pages Deployments",
  description: "A deployment of a Cloudflare Pages project",
  fields: [
    { key: "environment", label: "Environment", kind: "string", required: true },
    { key: "url", label: "URL", kind: "string", required: false },
    { key: "branch", label: "Branch", kind: "string", required: false },
    { key: "commitHash", label: "Commit", kind: "string", required: false },
    { key: "commitMessage", label: "Commit Message", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "createdOn", label: "Created", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "pages-project",
  dashboardPinnable: false,
  iconKey: "deployment",
};
