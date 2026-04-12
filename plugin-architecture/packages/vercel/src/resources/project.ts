import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VercelProjectResourceType: ResourceTypeDefinition = {
  id: "vercel-project",
  displayName: "Project",
  pluralDisplayName: "Projects",
  description: "A Vercel project — deploys from Git or CLI",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "framework", label: "Framework", kind: "string", required: false },
    { key: "nodeVersion", label: "Node Version", kind: "string", required: false },
    {
      key: "serverlessFunctionRegion",
      label: "Region",
      kind: "string",
      required: false,
    },
    { key: "rootDirectory", label: "Root Directory", kind: "string", required: false },
    { key: "buildCommand", label: "Build Command", kind: "string", required: false },
    { key: "outputDirectory", label: "Output Directory", kind: "string", required: false },
    { key: "productionUrl", label: "Production URL", kind: "string", required: false },
    { key: "gitRepo", label: "Git Repository", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "updatedAt", label: "Updated At", kind: "string", required: false },
    { key: "live", label: "Live", kind: "string", required: false },
  ],
  outputs: [
    { key: "projectId", label: "Project ID", sensitive: false },
    { key: "projectName", label: "Project Name", sensitive: false },
    { key: "productionUrl", label: "Production URL", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "vercel",
};
