import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifyBuildHookResourceType = rt({
  name: "Build Hook",
  pinnable: false,
  id: "netlify-build-hook",
  description: "A build hook that triggers deploys via a unique URL",
  fields: [
    f("title", "Title"),
    f("branch", "Branch", { required: false }),
    f("url", "Hook URL", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("siteId", "Site", { required: false }),
  ],
  outputs: [o("hookId", "Hook ID"), o("hookUrl", "Hook URL", { sensitive: true })],
  dependsOn: [{ fieldKey: "siteId", targetTypeId: "netlify-site", label: "builds site" }],
  parentTypeId: "netlify-site",
  supportsCreate: true,
  iconKey: "hook",
  attachTargets: [
    {
      pluginId: "netlify",
      resourceTypeId: "netlify-site",
      verb: "Import as env var",
    },
  ],
  secretExportTemplates: [
    {
      id: "build-hook-url",
      displayName: "Build Hook URL",
      description: "Webhook URL to trigger a deploy for a specific branch",
      entries: [{ envKey: "NETLIFY_BUILD_HOOK_URL", outputKey: "hookUrl" }],
    },
  ],
});
