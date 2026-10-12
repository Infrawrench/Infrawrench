import {
  deployField,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Railway deployments as deploy events. The environment's name lives on the
 * service instance the deployment belongs to (the deployment only has its
 * id), and `meta.reason` says `rollback` for Railway's own rollbacks.
 * `removed` is a deployment that was live and has been superseded.
 */
export const railwayDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["deployment"],
  toDeployEvent(resource, target) {
    const at = deployTime(resource, "createdAt");
    if (!at) return null;
    return {
      kind: "deployment",
      name: deployField(resource, "serviceName") ?? target?.displayName ?? resource.displayName,
      environment:
        (target && deployField(target, "environmentName")) ??
        deployField(resource, "environmentId"),
      repository: target ? deployField(target, "repo") : null,
      commitSha: deployField(resource, "commitHash"),
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "status"), {
        success: ["success", "removed", "sleeping"],
        failure: ["failed", "crashed"],
        canceled: ["skipped"],
      }),
      isRollback: deployField(resource, "reason")?.toLowerCase() === "rollback",
      url: deployField(resource, "url"),
    };
  },
};
