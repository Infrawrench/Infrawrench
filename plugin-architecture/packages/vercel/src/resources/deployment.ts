import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VercelDeploymentResourceType: ResourceTypeDefinition = {
  id: "vercel-deployment",
  displayName: "Deployment",
  pluralDisplayName: "Deployments",
  description: "A Vercel deployment — a specific build of a project",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "url", label: "URL", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "target", label: "Target", kind: "string", required: false },
    { key: "source", label: "Source", kind: "string", required: false },
    { key: "projectId", label: "Project ID", kind: "string", required: false },
    { key: "creatorEmail", label: "Creator", kind: "string", required: false },
    { key: "gitBranch", label: "Git Branch", kind: "string", required: false },
    { key: "gitCommitSha", label: "Commit SHA", kind: "string", required: false },
    { key: "gitCommitMessage", label: "Commit Message", kind: "string", required: false },
    { key: "inspectorUrl", label: "Inspector URL", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "readyAt", label: "Ready At", kind: "string", required: false },
    { key: "framework", label: "Framework", kind: "string", required: false },
  ],
  outputs: [
    { key: "deploymentId", label: "Deployment ID", sensitive: false },
    { key: "url", label: "Deployment URL", sensitive: false },
    { key: "inspectorUrl", label: "Inspector URL", sensitive: false },
  ],
  dashboardPinnable: false,
  iconKey: "deployment",
  attachTargets: [
    {
      pluginId: "vercel",
      resourceTypeId: "vercel-project",
      verb: "Import URL env var",
    },
  ],
};
