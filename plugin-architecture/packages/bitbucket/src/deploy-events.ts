import {
  deployField,
  deployOutput,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Bitbucket Pipelines runs as pipeline runs, matched against the org's
 * pipeline patterns by repository slug or custom pipeline selector. Pull
 * request pipelines never deploy and are skipped.
 */
export const bitbucketDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["pipeline"],
  toDeployEvent(resource) {
    if (deployField(resource, "refType") === "pullrequest") return null;
    const at = deployTime(resource, "completedAt") ?? deployTime(resource, "createdAt");
    if (!at) return null;
    const repo = deployField(resource, "repository");
    const selector = deployField(resource, "selector");
    return {
      kind: "pipeline",
      name: selector && repo ? `${repo} ${selector}` : (repo ?? resource.displayName),
      environment: null,
      repository: repo,
      commitSha: deployField(resource, "commit"),
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "result"), {
        success: ["successful"],
        failure: ["failed", "error"],
        canceled: ["stopped"],
      }),
      isRollback: false,
      url: deployOutput(resource, "webUrl"),
    };
  },
};
