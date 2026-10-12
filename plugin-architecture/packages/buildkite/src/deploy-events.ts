import {
  deployField,
  deployOutput,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Buildkite builds as pipeline runs: a build is a deploy only when its
 * pipeline's name or slug matches the org's pipeline patterns. Pull request
 * builds never deploy and are skipped.
 */
export const buildkiteDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["build"],
  toDeployEvent(resource, target) {
    if (resource.fields["pullRequest"] !== undefined && resource.fields["pullRequest"] !== null) {
      return null;
    }
    const at = deployTime(resource, "finishedAt") ?? deployTime(resource, "createdAt");
    if (!at) return null;
    return {
      kind: "pipeline",
      name:
        deployField(resource, "pipelineName") ??
        deployField(resource, "pipelineSlug") ??
        resource.displayName,
      environment: null,
      repository: target ? deployField(target, "repository") : null,
      commitSha: deployField(resource, "commit"),
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "state"), {
        success: ["passed"],
        failure: ["failed"],
        canceled: ["canceled", "skipped", "not_run"],
      }),
      isRollback: false,
      url: deployOutput(resource, "url"),
    };
  },
};
