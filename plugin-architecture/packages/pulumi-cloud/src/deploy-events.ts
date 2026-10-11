import {
  deployField,
  deployOutput,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Pulumi Deployments as deploy events. Only `update` operations change a
 * stack (previews, refreshes and destroys are not deploys), and the stack is
 * the environment, which is how Pulumi projects are usually laid out
 * (`dev`, `staging`, `prod`).
 */
export const pulumiDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["deployment"],
  toDeployEvent(resource) {
    if ((deployField(resource, "operation") ?? "").toLowerCase() !== "update") return null;
    const at = deployTime(resource, "created");
    if (!at) return null;
    const project = deployField(resource, "project");
    return {
      kind: "deployment",
      name: project ?? resource.displayName,
      environment: deployField(resource, "stack"),
      repository: null,
      commitSha: null,
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "status"), {
        success: ["succeeded"],
        failure: ["failed"],
        canceled: ["skipped"],
      }),
      isRollback: false,
      url: deployOutput(resource, "url"),
    };
  },
};
