import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PagesProjectResourceType: ResourceTypeDefinition = {
  id: "pages-project",
  displayName: "Pages Project",
  pluralDisplayName: "Pages Projects",
  description: "A Cloudflare Pages project for static site hosting",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "subdomain", label: "Subdomain", kind: "string", required: false },
    { key: "productionBranch", label: "Production Branch", kind: "string", required: false },
    { key: "latestDeploymentStatus", label: "Latest Deployment", kind: "string", required: false },
    { key: "latestDeploymentUrl", label: "Latest URL", kind: "string", required: false },
    { key: "framework", label: "Framework", kind: "string", required: false },
    { key: "domains", label: "Custom Domains", kind: "string", required: false },
  ],
  outputs: [
    { key: "subdomain", label: "Pages Subdomain", sensitive: false },
    { key: "projectName", label: "Project Name", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "pages",
};
