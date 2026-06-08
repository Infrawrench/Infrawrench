import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NetlifyDeployResourceType: ResourceTypeDefinition = {
  id: "netlify-deploy",
  displayName: "Deploy",
  pluralDisplayName: "Deploys",
  description: "A deployment of a Netlify site",
  fields: [
    { key: "state", label: "State", kind: "string", required: true },
    { key: "context", label: "Context", kind: "string", required: false },
    { key: "branch", label: "Branch", kind: "string", required: false },
    { key: "commitRef", label: "Commit", kind: "string", required: false },
    { key: "commitUrl", label: "Commit URL", kind: "string", required: false },
    { key: "title", label: "Title", kind: "string", required: false },
    { key: "url", label: "Deploy URL", kind: "string", required: false },
    { key: "sslUrl", label: "SSL Deploy URL", kind: "string", required: false },
    { key: "errorMessage", label: "Error", kind: "string", required: false },
    { key: "framework", label: "Framework", kind: "string", required: false },
    { key: "draft", label: "Draft", kind: "boolean", required: false },
    { key: "locked", label: "Locked", kind: "boolean", required: false },
    { key: "skipped", label: "Skipped", kind: "boolean", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "publishedAt", label: "Published At", kind: "string", required: false },
  ],
  outputs: [
    { key: "deployId", label: "Deploy ID", sensitive: false },
    { key: "deployUrl", label: "Deploy URL", sensitive: false },
  ],
  parentTypeId: "netlify-site",
  dashboardPinnable: false,
  iconKey: "deployment",
  attachTargets: [
    {
      pluginId: "netlify",
      resourceTypeId: "netlify-site",
      verb: "Publish deploy",
    },
  ],
};
