import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifyDeployResourceType = rt({
  name: "Deploy",
  pinnable: false,
  id: "netlify-deploy",
  description: "A deployment of a Netlify site",
  fields: [
    f("state", "State"),
    f("context", "Context", { required: false }),
    f("branch", "Branch", { required: false }),
    f("commitRef", "Commit", { required: false }),
    f("commitUrl", "Commit URL", { required: false }),
    f("title", "Title", { required: false }),
    f("url", "Deploy URL", { required: false }),
    f("sslUrl", "SSL Deploy URL", { required: false }),
    f("errorMessage", "Error", { required: false }),
    f("framework", "Framework", { required: false }),
    f("draft", "Draft", { kind: "boolean", required: false }),
    f("locked", "Locked", { kind: "boolean", required: false }),
    f("skipped", "Skipped", { kind: "boolean", required: false }),
    f("createdAt", "Created At", { required: false }),
    f("publishedAt", "Published At", { required: false }),
  ],
  outputs: [o("deployId", "Deploy ID"), o("deployUrl", "Deploy URL")],
  parentTypeId: "netlify-site",
  iconKey: "deployment",
  attachTargets: [
    {
      pluginId: "netlify",
      resourceTypeId: "netlify-site",
      verb: "Publish deploy",
    },
  ],
});
