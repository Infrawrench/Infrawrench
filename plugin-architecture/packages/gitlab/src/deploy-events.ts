import {
  deployField,
  deployOutput,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * GitLab pipelines as pipeline runs: a pipeline is a deploy only when the
 * org's pipeline patterns match it, by pipeline name or project path (GitLab's
 * own deployments API is only listed per environment, newest first, and the
 * DORA endpoint is Ultimate-only). The SHA is stored abbreviated to 12
 * characters, which is enough to resolve the commit.
 */
export const gitlabDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["pipeline"],
  toDeployEvent(resource) {
    const at = deployTime(resource, "finishedAt") ?? deployTime(resource, "createdAt");
    if (!at) return null;
    const project = deployField(resource, "project");
    return {
      kind: "pipeline",
      name: deployField(resource, "name") ?? project ?? resource.displayName,
      environment: null,
      repository: project,
      commitSha: deployField(resource, "sha"),
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "status"), {
        success: ["success"],
        failure: ["failed"],
        canceled: ["canceled", "skipped"],
      }),
      isRollback: false,
      url: deployOutput(resource, "webUrl"),
    };
  },
};
