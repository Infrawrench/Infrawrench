import { f, o, rt } from "@infrawrench/plugin-base";

export const VercelDeploymentResourceType = rt({
  name: "Deployment",
  pinnable: false,
  id: "vercel-deployment",
  description: "A Vercel deployment — a specific build of a project",
  fields: [
    f("name", "Name"),
    f("url", "URL", { required: false }),
    f("state", "State", { required: false }),
    f("target", "Target", { required: false }),
    f("source", "Source", { required: false }),
    f("projectId", "Project ID", { required: false }),
    f("creatorEmail", "Creator", { required: false }),
    f("gitBranch", "Git Branch", { required: false }),
    f("gitCommitSha", "Commit SHA", { required: false }),
    f("gitCommitMessage", "Commit Message", { required: false }),
    f("inspectorUrl", "Inspector URL", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("readyAt", "Ready At", { required: false }),
    f("framework", "Framework", { required: false }),
  ],
  outputs: [
    o("deploymentId", "Deployment ID"),
    o("url", "Deployment URL"),
    o("inspectorUrl", "Inspector URL"),
  ],
  iconKey: "deployment",
  attachTargets: [
    {
      pluginId: "vercel",
      resourceTypeId: "vercel-project",
      verb: "Import URL env var",
    },
  ],
});
