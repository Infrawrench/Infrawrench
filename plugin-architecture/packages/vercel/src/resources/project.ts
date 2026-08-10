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
    f("ownerId", "Owner", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
    f("live", "Live", { required: false }),
  ],
  outputs: [
    o("projectId", "Project ID"),
    o("projectName", "Project Name"),
    o("productionUrl", "Production URL"),
  ],
  // Vercel calls the owner `accountId`; it holds the `team_…` id for a
  // team-owned project and a personal user id otherwise, so the rule simply
  // finds nothing on personal accounts.
  dependsOn: [{ fieldKey: "ownerId", targetTypeId: "vercel-team", label: "owned by" }],
  supportsCreate: true,
  iconKey: "vercel",
  // Stable alias is `<project>.vercel.app`; git-branch aliases are
  // `<project>-git-<branch>-<scope>.vercel.app`. Capture group 1 is the
  // project name so the name claimant resolves both. Deployment-hash forms
  // the lister stores on `productionUrl` are matched via hostKeys instead.
  dnsServiceHosts: [
    {
      id: "vercel-alias",
      label: "Vercel deployment alias",
      // Non-greedy project label so `-git-<branch>-<scope>` is peeled off
      // rather than absorbed into the name.
      hostPattern: String.raw`([a-z0-9][a-z0-9-]*?)(?:-git-[a-z0-9-]+)?\.vercel\.app`,
      hostKeys: ["productionUrl"],
      reason:
        "Deleting or renaming the project frees the alias for any Vercel user to claim, and Vercel will serve their deployment under your hostname.",
    },
  ],
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
