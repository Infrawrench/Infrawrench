import {
  deployField,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Vercel deployments as deploy events. `target` is `production` or absent
 * (a preview), and `readyAt` is when the deployment started serving. The
 * project is named by a field rather than a parent link, hence `targetOf`.
 */
export const vercelDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["vercel-deployment"],
  targetOf(resource) {
    const projectId = deployField(resource, "projectId");
    return projectId ? { resourceTypeId: "vercel-project", externalId: projectId } : null;
  },
  toDeployEvent(resource, target) {
    const at = deployTime(resource, "readyAt") ?? deployTime(resource, "createdAt");
    if (!at) return null;
    return {
      kind: "deployment",
      name:
        (target && deployField(target, "name")) ??
        deployField(resource, "name") ??
        resource.displayName,
      environment: deployField(resource, "target") ?? "preview",
      repository: target ? deployField(target, "gitRepo") : null,
      commitSha: deployField(resource, "gitCommitSha"),
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "state"), {
        success: ["ready"],
        failure: ["error"],
        canceled: ["canceled"],
      }),
      // Vercel's instant rollback re-points the production alias without a new
      // deployment, so there is no row to flag; a redeploy of an old commit is
      // caught by the host's generic rule instead.
      isRollback: false,
      url: deployField(resource, "inspectorUrl") ?? deployField(resource, "url"),
    };
  },
};
