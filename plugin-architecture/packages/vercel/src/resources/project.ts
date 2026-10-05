import { f, o, rt } from "@infrawrench/plugin-base";
import { FRAMEWORK_IDS, FUNCTION_REGIONS, NODE_VERSIONS } from "../catalog.js";

export const VercelProjectResourceType = rt({
  name: "Project",
  id: "vercel-project",
  description: "A Vercel project, deployed from Git or the CLI",
  fields: [
    f("name", "Name"),
    f("framework", "Framework", { kind: "enum", enumValues: FRAMEWORK_IDS, required: false }),
    f("nodeVersion", "Node Version", { kind: "enum", enumValues: NODE_VERSIONS, required: false }),
    f("serverlessFunctionRegion", "Region", {
      kind: "enum",
      enumValues: FUNCTION_REGIONS.map((r) => r.id),
      required: false,
      description: "Default region Vercel Functions run in",
    }),
    f("rootDirectory", "Root Directory", { required: false }),
    f("buildCommand", "Build Command", { required: false }),
    f("installCommand", "Install Command", { required: false }),
    f("devCommand", "Development Command", { required: false }),
    f("outputDirectory", "Output Directory", { required: false }),
    f("productionUrl", "Production URL", { required: false, editable: false }),
    f("gitRepo", "Git Repository", { required: false, editable: false }),
    f("ownerId", "Owner", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
    f("live", "Live", { required: false, editable: false }),
    f("paused", "Paused", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "A paused project serves a 503 for every request until it is resumed",
    }),
    f("attackModeEnabled", "Attack Challenge Mode", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "Every visitor must pass a browser challenge before reaching the site",
    }),
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
  supportsUpdate: true,
  // Web Analytics page views, visitors and custom events (production only).
  supportsMetrics: true,
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
