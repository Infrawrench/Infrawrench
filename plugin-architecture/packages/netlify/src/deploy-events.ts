import {
  deployField,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Netlify deploys as deploy events. `context` is the environment
 * (`production`, `deploy-preview`, `branch-deploy`); a deploy goes live at
 * `publishedAt`. Skipped deploys shipped nothing and are not events.
 */
export const netlifyDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["netlify-deploy"],
  toDeployEvent(resource, target) {
    if (resource.fields["skipped"] === true) return null;
    const at = deployTime(resource, "publishedAt") ?? deployTime(resource, "createdAt");
    if (!at) return null;
    return {
      kind: "deployment",
      name: (target && deployField(target, "name")) ?? target?.displayName ?? resource.displayName,
      environment: deployField(resource, "context"),
      repository: target ? deployField(target, "repoUrl") : null,
      commitSha: deployField(resource, "commitRef"),
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "state"), {
        success: ["ready"],
        failure: ["error", "rejected"],
        canceled: ["cancelled", "canceled"],
      }),
      isRollback: false,
      url: deployField(resource, "url"),
    };
  },
};
