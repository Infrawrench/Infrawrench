import {
  deployField,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Render deploys as deploy events. A Render service has no environment of its
 * own (staging is a separate service), and a live deploy serves traffic, so
 * the environment is `production`; an org that names staging services can
 * scope them out by repository or owner. `trigger: rollback` is Render's own
 * rollback flag.
 */
export const renderDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["deploy"],
  toDeployEvent(resource, target) {
    const at =
      deployTime(resource, "finishedAt") ??
      deployTime(resource, "startedAt") ??
      deployTime(resource, "createdAt");
    if (!at) return null;
    return {
      kind: "deployment",
      name: deployField(resource, "serviceName") ?? target?.displayName ?? resource.displayName,
      environment: "production",
      repository: target ? deployField(target, "repo") : null,
      commitSha: deployField(resource, "commitId"),
      commitAt: deployTime(resource, "commitCreatedAt"),
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "status"), {
        // `deactivated` is a deploy that was live and has since been replaced.
        success: ["live", "deactivated"],
        failure: ["build_failed", "update_failed", "pre_deploy_failed"],
        canceled: ["canceled"],
      }),
      isRollback: deployField(resource, "trigger") === "rollback",
      url: null,
    };
  },
};
