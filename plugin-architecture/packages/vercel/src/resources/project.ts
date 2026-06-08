import { f, o, rt } from "@infrawrench/plugin-base";

export const VercelProjectResourceType = rt({
  name: "Project",
  id: "vercel-project",
  description: "A Vercel project — deploys from Git or CLI",
  fields: [
    f("name", "Name"),
    f("framework", "Framework", { required: false }),
    f("nodeVersion", "Node Version", { required: false }),
    f("serverlessFunctionRegion", "Region", { required: false }),
    f("rootDirectory", "Root Directory", { required: false }),
    f("buildCommand", "Build Command", { required: false }),
    f("outputDirectory", "Output Directory", { required: false }),
    f("productionUrl", "Production URL", { required: false }),
    f("gitRepo", "Git Repository", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
    f("live", "Live", { required: false }),
  ],
  outputs: [
    o("projectId", "Project ID"),
    o("projectName", "Project Name"),
    o("productionUrl", "Production URL"),
  ],
  supportsCreate: true,
  iconKey: "vercel",
  secretExportTemplates: [
    {
      id: "vercel-project",
      displayName: "Vercel Project",
      description:
        "Project identifiers for use with Vercel CLI / API. Pair with a `VERCEL_TOKEN` from your team's tokens page.",
      entries: [
        { envKey: "VERCEL_PROJECT_ID", outputKey: "projectId" },
        { envKey: "VERCEL_PROJECT_NAME", outputKey: "projectName" },
        { envKey: "VERCEL_PRODUCTION_URL", outputKey: "productionUrl" },
      ],
    },
  ],
});
