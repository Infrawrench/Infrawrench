import {
  deployField,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Koyeb deployments as deploy events. A Koyeb service has no environment
 * (staging is another app or service), so the environment is `production`.
 * `stopped` is a deployment that was healthy and has since been replaced.
 */
export const koyebDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["deployment"],
  toDeployEvent(resource, target) {
    const at = deployTime(resource, "succeededAt") ?? deployTime(resource, "createdAt");
    if (!at) return null;
    return {
      kind: "deployment",
      name: target?.displayName ?? resource.displayName,
      environment: "production",
      repository: target ? deployField(target, "repository") : null,
      commitSha: deployField(resource, "sha"),
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "status"), {
        success: ["healthy", "stopped", "stopping", "sleeping", "degraded"],
        failure: ["error", "erroring", "unhealthy"],
        canceled: ["canceled", "canceling", "stashed"],
      }),
      isRollback: deployField(resource, "trigger") === "rollback",
      url: null,
    };
  },
};
