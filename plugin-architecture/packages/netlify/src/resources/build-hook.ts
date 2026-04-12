import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NetlifyBuildHookResourceType: ResourceTypeDefinition = {
  id: "netlify-build-hook",
  displayName: "Build Hook",
  pluralDisplayName: "Build Hooks",
  description: "A build hook that triggers deploys via a unique URL",
  fields: [
    { key: "title", label: "Title", kind: "string", required: true },
    { key: "branch", label: "Branch", kind: "string", required: false },
    { key: "url", label: "Hook URL", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
  ],
  outputs: [
    { key: "hookId", label: "Hook ID", sensitive: false },
    { key: "hookUrl", label: "Hook URL", sensitive: true },
  ],
  parentTypeId: "netlify-site",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "hook",
  secretExportTemplates: [
    {
      id: "build-hook-url",
      displayName: "Build Hook URL",
      description: "Webhook URL to trigger a deploy for a specific branch",
      entries: [{ envKey: "NETLIFY_BUILD_HOOK_URL", outputKey: "hookUrl" }],
    },
  ],
};
